// Read replicas of one primary shard. Valkey's AOF already is a replication stream: every write, as
// the commands that redo it. So a replica is sent the AOF files as a starting copy, then every append
// as it happens, over one socket per replica. Replicas keep their data in memory only; one that
// resets starts empty, and its primary copies it again.
import { REPL_BACKLOG, REPL_COPY_MS, REPL_IDLE_MS, REPL_RETRY_MS, REPL_STUCK_MS, REPL_TICK_MS } from "../constants.js";
import { command, concat } from "../protocol/resp.js";

const REPLY_OFF = command(["CLIENT", "REPLY", "OFF"]);
// With replies off, only this comes back: "+OK" then "+PONG", once the replica has run everything before it.
const MARK = concat([command(["CLIENT", "REPLY", "ON"]), command(["PING"]), command(["CLIENT", "REPLY", "OFF"])]);
// The stream's connection is the import source (replicas run with import-mode): to it no key is ever expired.
// Redis lacks the command (its import-mode treats every write as the stream's); with replies off the error is unseen.
const START = concat([REPLY_OFF, command(["CLIENT", "IMPORT-SOURCE", "ON"]), command(["FLUSHALL"])]);
export const MANIFEST = "aof/appendonly.aof.manifest";
const COPY_CHUNK = 1 << 20;

export const replicaName = (primary, region) => `${primary}.r.${region}`;
// The class (binding) that holds the replicas of shard class k's primaries: never one a primary uses.
export const replicaBinding = (k) => `SHARD${8 + k}`;

/** The AOF files as of now, from the manifest: the base, the incr files in order, and every entry with its line. */
export function aofFiles(host) {
  const size = host.fileSize(MANIFEST);
  if (size === null) throw new Error("no AOF manifest yet");
  const entries = new TextDecoder().decode(host.readFile(MANIFEST, 0, size)).split("\n").filter((l) => l.startsWith("file "))
    .map((line) => { const w = line.trim().split(/\s+/); return { path: `aof/${w[1]}`, type: w[w.indexOf("type") + 1], line }; });
  return { base: entries.find((e) => e.type === "b")?.path, incrs: entries.filter((e) => e.type === "i").map((e) => e.path), entries };
}

export class Replicator {
  #ctx; #env; #host; #name; #ns;
  #targets = new Map(); // region -> state
  #copying = 0;
  #lastAppend = Date.now();
  #asleep = false; // idle: replicas retired, no alarm; activity or a write wakes it. Stored (repl_asleep)

  constructor(ctx, env, host, name, ns) {
    this.#ctx = ctx; this.#env = env; this.#host = host; this.#name = name; this.#ns = ns; // ns: the class its replicas live in
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS repl_targets (region TEXT PRIMARY KEY)`);
    for (const { region } of ctx.storage.sql.exec(`SELECT region FROM repl_targets`).toArray()) this.#targets.set(region, idle(region));
    // A sleeping primary is soon evicted, and whatever boots it next (a look from the dashboard, say) must not
    // copy every replica again: only activity wakes it.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS repl_asleep (since INTEGER NOT NULL)`);
    this.#asleep = ctx.storage.sql.exec(`SELECT 1 FROM repl_asleep`).toArray().length > 0;
    if (this.#targets.size && !this.#asleep) ctx.storage.setAlarm(Date.now() + 100);
  }

  get configured() { return this.#targets.size > 0; }
  get copying() { return this.#copying > 0; }
  rdbDue = false; // copies are done: the next quiet moment should rewrite the base back to RDB
  #basing = null; // the rewrite to a command base that copies starting now wait for (#commandBase)

  /** Sets the regions this shard keeps replicas in, remembered across restarts. */
  configure(regions) {
    const sql = this.#ctx.storage.sql;
    sql.exec(`DELETE FROM repl_targets`);
    for (const r of regions) sql.exec(`INSERT INTO repl_targets (region) VALUES (?)`, r);
    for (const [r, t] of this.#targets) if (!regions.includes(r)) { this.#drop(t, "no longer configured"); this.#targets.delete(r); }
    for (const r of regions) if (!this.#targets.has(r)) this.#targets.set(r, idle(r));
    this.wake(); // configuring (re)starts the replicas
    this.#ctx.storage.setAlarm(Date.now());
  }

  /** The database is being dropped: every replica stops serving, and nothing copies again. */
  async retireAll() {
    const regions = [...this.#targets.keys()];
    this.#asleep = true;
    for (const t of this.#targets.values()) this.#drop(t, "dropped");
    this.#targets.clear();
    await Promise.all(regions.map((r) => this.#ns.getByName(replicaName(this.#name, r), { locationHint: r }).retire().catch(() => {})));
  }

  /** Client activity on the primary: if replication went to sleep, start copying again. */
  wake() {
    if (!this.#asleep) return;
    this.#asleep = false;
    this.#ctx.storage.sql.exec(`DELETE FROM repl_asleep`);
    for (const t of this.#targets.values()) t.retryAt = 0;
    this.#ctx.storage.setAlarm(Date.now());
  }

  // Nothing has happened on the primary or its replicas for REPL_IDLE_MS: retire the replicas and stop the
  // alarm, so the whole database can be evicted instead of waking every REPL_TICK_MS forever.
  async #sleepIfIdle(now) {
    const ts = [...this.#targets.values()];
    if (now - this.#lastAppend < REPL_IDLE_MS || now - this.#host.lastActive < REPL_IDLE_MS) return false;
    if (!ts.every((t) => t.phase === "live" && t.ready && !t.inflight)) return false;
    const idle = await Promise.all(ts.map((t) => t.stub.replicaIdleMs().catch(() => 0)));
    if (!idle.every((ms) => ms >= REPL_IDLE_MS) || this.#lastAppend > now || this.#host.lastActive > now) return false;
    this.#asleep = true;
    this.#ctx.storage.sql.exec(`INSERT INTO repl_asleep VALUES (?)`, now);
    for (const t of ts) this.#drop(t, "asleep: idle");
    return true;
  }

  /** Called from the shard's alarm: starts copies for replicas that need one, and measures the others. Copies
   *  run on after it returns, so one slow copy doesn't hold up the others' markers or the next alarm. */
  async tick() {
    const now = Date.now();
    if (this.#asleep || (this.#targets.size && (await this.#sleepIfIdle(now)))) return;
    for (const t of this.#targets.values()) {
      if (t.phase === "idle" && now >= t.retryAt) this.#sync(t).catch((e) => console.log(`replica ${this.#name} -> ${t.region} copy: ${e.message}`));
      else if (t.phase === "copying" && now - t.since > REPL_COPY_MS) this.#drop(t, "the copy took too long");
      else if (t.phase === "live") {
        if (t.marks.length && now - t.marks[0].at > REPL_STUCK_MS) { this.#drop(t, "stopped answering"); continue; }
        if (!t.marks.length) { t.marks.push({ at: now }); this.#send(t, MARK); }
      }
    }
    if (this.#targets.size) await this.#ctx.storage.setAlarm(Date.now() + REPL_TICK_MS);
  }

  /** How many replicas have applied every append so far: a marker goes behind everything already sent to each
   *  live replica, and this resolves once `n` have answered, or after `ms` (0: REPL_STUCK_MS). A replica that is
   *  copying, or about to (waking from sleep, say), gets its marker once it is live: its copy has every append. */
  wait(n, ms) {
    let acked = 0, finish;
    const done = new Promise((r) => (finish = r));
    if (n <= 0 || !this.#targets.size) { finish(0); return done; }
    const timer = setTimeout(() => finish(acked), ms > 0 ? ms : REPL_STUCK_MS);
    const onAck = () => { if (++acked >= n) { clearTimeout(timer); finish(acked); } };
    for (const t of this.#targets.values()) {
      if (t.phase !== "live") { t.waiting.push(onAck); continue; }
      t.marks.push({ at: Date.now(), onAck });
      this.#send(t, MARK);
    }
    return done;
  }

  status() {
    return [...this.#targets.values()].map((t) => ({ region: t.region, state: this.#asleep ? "asleep" : t.phase === "live" ? (t.ready ? "ready" : "catching up") : t.phase, lagMs: t.lagMs, colo: t.colo, behindBytes: t.phase === "live" ? t.inflight : t.queued, error: t.error }));
  }

  // ---- the stream ----

  /** Every append to the AOF's incr file, in order: the stream each replica is sent. */
  append(bytes) {
    this.#lastAppend = Date.now();
    this.wake();
    for (const t of this.#targets.values()) {
      if (t.phase === "copying") {
        t.queue.push(bytes); t.queued += bytes.length; this.#host.hold(bytes.length);
        if (t.queued > REPL_BACKLOG) this.#drop(t, "fell too far behind while copying");
      } else if (t.phase === "live") this.#send(t, bytes);
    }
  }

  // One socket write at a time per replica: each write waits for the output gate and a turn of the event
  // loop, so appends that arrive meanwhile go out together as one write.
  #send(t, bytes) {
    t.inflight += bytes.length; this.#host.hold(bytes.length);
    if (t.inflight > REPL_BACKLOG) return this.#drop(t, "fell too far behind");
    t.out.push(bytes);
    if (!t.writing) this.#pump(t);
  }

  #pump(t) {
    const out = t.out.length === 1 ? t.out[0] : concat(t.out);
    t.out = []; t.writing = true;
    const writer = t.writer;
    writer.write(out).then(() => {
      if (t.writer !== writer) return;
      t.inflight -= out.length; this.#host.release(out.length); t.writing = false;
      if (t.out.length) this.#pump(t);
    }, (e) => this.#drop(t, `socket: ${e.message}`));
  }

  #files() { return aofFiles(this.#host); }

  // Commands, not RDB, in the base file (a replica runs the files as commands), and no rewrite while a copy
  // runs: the files only grow. Once no copy is running the base goes back to RDB, which is ~6x smaller, so
  // each later rewrite (one commit that holds every reply) blocks the shard ~6x less. Shared: copies to every
  // replica start together, and one rewrite serves them all (each starting its own, all but the first found
  // one already running, gave up, and retried into the next RDB rewrite).
  #commandBase() {
    this.#basing ??= (async () => {
      await this.#host.execBatch(command(["CONFIG", "SET", "aof-use-rdb-preamble", "no"]), 1);
      await this.#host.rewriting; // a rewrite that is running would replace the files mid-copy
      if (this.#files().base?.endsWith(".rdb")) { await this.#host.execBatch(command(["BGREWRITEAOF"]), 1); await this.#host.rewriting; }
    })().finally(() => { this.#basing = null; });
    return this.#basing;
  }

  async #sync(t) {
    Object.assign(t, { phase: "copying", since: Date.now(), queue: [], queued: 0, inflight: 0, out: [], writing: false, marks: [], ready: false, error: null });
    this.#copying++;
    try {
      await this.#commandBase();
      if (t.phase !== "copying") return;
      if (this.#files().base?.endsWith(".rdb")) throw new Error("the base is still RDB (its rewrite failed)");
      // Sizes now, synchronously: appends from here on are queued for this replica.
      const { base, incrs } = this.#files();
      const parts = [base, ...incrs].filter(Boolean).map((p) => [p, this.#host.fileSize(p) ?? 0]);
      this.#host.release(t.queued); t.queue = []; t.queued = 0;
      const stub = this.#ns.getByName(replicaName(this.#name, t.region), { locationHint: t.region });
      t.stub = stub;
      t.socket = stub.connect("repl:6379");
      t.writer = t.socket.writable.getWriter();
      this.#readMarks(t);
      await t.writer.write(START);
      for (const [p, size] of parts) for (let pos = 0; pos < size && t.phase === "copying"; pos += COPY_CHUNK) await t.writer.write(this.#host.readFile(p, pos, COPY_CHUNK));
      t.marks.push({ at: Date.now(), ready: true });
      await t.writer.write(MARK);
      while (t.phase === "copying" && t.queue.length) { const b = t.queue.shift(); t.queued -= b.length; this.#host.release(b.length); await t.writer.write(b); }
      if (t.phase === "copying") { // no await since the queue emptied, so no append is missed
        t.phase = "live";
        const waiting = t.waiting.splice(0); // WAITs that started before it was live
        if (waiting.length) { t.marks.push({ at: Date.now(), onAck: () => waiting.forEach((f) => f()) }); this.#send(t, MARK); }
      }
    } catch (e) {
      this.#drop(t, e.message);
    } finally {
      if (--this.#copying === 0) {
        await this.#host.execBatch(command(["CONFIG", "SET", "aof-use-rdb-preamble", "yes"]), 1).catch(() => {});
        this.rdbDue = this.#files().base?.endsWith(".aof") ?? false;
      }
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
          m.onAck?.();
          if (m.ready) t.colo = await t.stub.replicaReady().then((c) => { t.ready = true; return c; }, () => null);
        }
        carry = text.slice(Math.max(at, text.length - 6));
      }
    } catch { /* closed */ }
    if (t.socket === socket) this.#drop(t, "replica closed the connection", false); // it's gone already
  }

  #drop(t, why, tell = true) {
    if (t.phase === "idle") return;
    // A close from this end doesn't reach the replica, so tell it: it must not serve data that stopped updating.
    if (tell) t.stub?.retire().catch(() => {});
    try { t.writer?.abort?.(why); } catch { /* gone */ }
    try { t.socket?.close?.(); } catch { /* gone */ }
    this.#host.release(t.inflight + t.queued);
    Object.assign(t, { phase: "idle", socket: null, writer: null, queue: [], queued: 0, inflight: 0, out: [], writing: false, marks: [], waiting: [], ready: false, error: why, retryAt: Date.now() + REPL_RETRY_MS });
    console.log(`replica ${this.#name} -> ${t.region} dropped: ${why}`);
  }
}

const idle = (region) => ({ region, phase: "idle", retryAt: 0, queue: [], queued: 0, inflight: 0, marks: [], waiting: [], ready: false, lagMs: null, colo: null, error: null });
