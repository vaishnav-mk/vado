// Read replicas of one primary shard. Valkey's AOF already is a replication stream: every write, as
// the commands that redo it. So a replica is sent the AOF files as a starting copy, then every append
// as it happens, over one socket per replica. Replicas keep their data in memory only; one that
// resets starts empty, and its primary copies it again.
import { REPL_BACKLOG, REPL_RETRY_MS, REPL_STUCK_MS, REPL_TICK_MS } from "./constants.js";
import { command, concat } from "./resp.js";

const REPLY_OFF = command(["CLIENT", "REPLY", "OFF"]);
// With replies off, only this comes back: "+OK" then "+PONG", once the replica has run everything before it.
const MARK = concat([command(["CLIENT", "REPLY", "ON"]), command(["PING"]), command(["CLIENT", "REPLY", "OFF"])]);
const START = concat([REPLY_OFF, command(["FLUSHALL"])]);
const MANIFEST = "aof/appendonly.aof.manifest";
const COPY_CHUNK = 1 << 20;

export const replicaName = (primary, region) => `${primary}.r.${region}`;

export class Replicator {
  #ctx; #env; #host; #name;
  #targets = new Map(); // region -> state
  #copying = 0;

  constructor(ctx, env, host, name) {
    this.#ctx = ctx; this.#env = env; this.#host = host; this.#name = name;
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS repl_targets (region TEXT PRIMARY KEY)`);
    for (const { region } of ctx.storage.sql.exec(`SELECT region FROM repl_targets`).toArray()) this.#targets.set(region, idle(region));
    if (this.#targets.size) ctx.storage.setAlarm(Date.now() + 100);
  }

  get configured() { return this.#targets.size > 0; }
  get copying() { return this.#copying > 0; }

  /** Sets the regions this shard keeps replicas in, remembered across restarts. */
  configure(regions) {
    const sql = this.#ctx.storage.sql;
    sql.exec(`DELETE FROM repl_targets`);
    for (const r of regions) sql.exec(`INSERT INTO repl_targets (region) VALUES (?)`, r);
    for (const [r, t] of this.#targets) if (!regions.includes(r)) { this.#drop(t, "no longer configured"); this.#targets.delete(r); }
    for (const r of regions) if (!this.#targets.has(r)) this.#targets.set(r, idle(r));
    this.#ctx.storage.setAlarm(Date.now());
  }

  /** Called from the shard's alarm: starts copies for replicas that need one, and measures the others. */
  async tick() {
    const now = Date.now(), copies = [];
    for (const t of this.#targets.values()) {
      if (t.phase === "idle" && now >= t.retryAt) copies.push(this.#sync(t));
      else if (t.phase === "live") {
        if (t.marks.length && now - t.marks[0].at > REPL_STUCK_MS) { this.#drop(t, "stopped answering"); continue; }
        if (!t.marks.length) { t.marks.push({ at: now }); this.#send(t, MARK); }
      }
    }
    if (this.#targets.size) await this.#ctx.storage.setAlarm(Date.now() + REPL_TICK_MS);
    await Promise.all(copies);
  }

  status() {
    return [...this.#targets.values()].map((t) => ({ region: t.region, state: t.phase === "live" ? (t.ready ? "ready" : "catching up") : t.phase, lagMs: t.lagMs, colo: t.colo, behindBytes: t.phase === "live" ? t.inflight : t.queued, error: t.error }));
  }

  // ---- the stream ----

  /** Every append to the AOF's incr file, in order: the stream each replica is sent. */
  append(bytes) {
    for (const t of this.#targets.values()) {
      if (t.phase === "copying") {
        t.queue.push(bytes); t.queued += bytes.length;
        if (t.queued > REPL_BACKLOG) this.#drop(t, "fell too far behind while copying");
      } else if (t.phase === "live") this.#send(t, bytes);
    }
  }

  #send(t, bytes) {
    t.inflight += bytes.length;
    if (t.inflight > REPL_BACKLOG) return this.#drop(t, "fell too far behind");
    t.writer.write(bytes).then(() => { t.inflight -= bytes.length; }, (e) => this.#drop(t, `socket: ${e.message}`));
  }

  // The AOF files as of now: the base, then the incr files in order, from the manifest.
  #files() {
    const size = this.#host.fileSize(MANIFEST);
    if (size === null) throw new Error("no AOF manifest yet");
    const lines = new TextDecoder().decode(this.#host.readFile(MANIFEST, 0, size)).split("\n").map((l) => l.trim().split(/\s+/)).filter((w) => w[0] === "file");
    const pick = (type) => lines.filter((w) => w[w.indexOf("type") + 1] === type).map((w) => `aof/${w[1]}`);
    return { base: pick("b")[0], incrs: pick("i") };
  }

  async #sync(t) {
    Object.assign(t, { phase: "copying", since: Date.now(), queue: [], queued: 0, inflight: 0, marks: [], ready: false, error: null });
    this.#copying++;
    try {
      // Commands, not RDB, in the base file, and no rewrite while the copy runs: the files only grow.
      await this.#host.execBatch(command(["CONFIG", "SET", "aof-use-rdb-preamble", "no", "auto-aof-rewrite-percentage", "0"]), 1);
      if (this.#files().base?.endsWith(".rdb")) await this.#host.execBatch(command(["BGREWRITEAOF"]), 1);
      if (t.phase !== "copying") return;
      // Sizes now, synchronously: appends from here on are queued for this replica.
      const { base, incrs } = this.#files();
      const parts = [base, ...incrs].filter(Boolean).map((p) => [p, this.#host.fileSize(p) ?? 0]);
      t.queue = []; t.queued = 0;
      const stub = this.#env.SHARD.getByName(replicaName(this.#name, t.region), { locationHint: t.region });
      t.stub = stub;
      t.socket = stub.connect("repl:6379");
      t.writer = t.socket.writable.getWriter();
      this.#readMarks(t);
      await t.writer.write(START);
      for (const [p, size] of parts) for (let pos = 0; pos < size && t.phase === "copying"; pos += COPY_CHUNK) await t.writer.write(this.#host.readFile(p, pos, COPY_CHUNK));
      t.marks.push({ at: Date.now(), ready: true });
      await t.writer.write(MARK);
      while (t.phase === "copying" && t.queue.length) { const b = t.queue.shift(); t.queued -= b.length; await t.writer.write(b); }
      if (t.phase === "copying") t.phase = "live"; // no await since the queue emptied, so no append is missed
    } catch (e) {
      this.#drop(t, e.message);
    } finally {
      this.#copying--;
    }
  }

  // Each "+PONG" answers the oldest marker. The first (after the copy) makes the replica serve reads.
  async #readMarks(t) {
    const socket = t.socket, reader = socket.readable.getReader(), dec = new TextDecoder();
    let carry = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || t.socket !== socket) break;
        const text = carry + dec.decode(value, { stream: true });
        let at = 0;
        for (let i; (i = text.indexOf("+PONG\r\n", at)) >= 0; at = i + 7) {
          const m = t.marks.shift();
          if (!m) continue;
          t.lagMs = Date.now() - m.at;
          if (m.ready) t.colo = await t.stub.replicaReady().then((c) => { t.ready = true; return c; }, () => null);
        }
        carry = text.slice(Math.max(at, text.length - 6));
      }
    } catch { /* closed */ }
    if (t.socket === socket) this.#drop(t, "replica closed the connection");
  }

  #drop(t, why) {
    if (t.phase === "idle") return;
    try { t.writer?.abort?.(why); } catch { /* gone */ }
    try { t.socket?.close?.(); } catch { /* gone */ }
    Object.assign(t, { phase: "idle", socket: null, writer: null, queue: [], queued: 0, inflight: 0, marks: [], ready: false, error: why, retryAt: Date.now() + REPL_RETRY_MS });
    console.log(`replica ${this.#name} -> ${t.region} dropped: ${why}`);
  }
}

const idle = (region) => ({ region, phase: "idle", retryAt: 0, queue: [], queued: 0, inflight: 0, marks: [], ready: false, lagMs: null, colo: null, error: null });
