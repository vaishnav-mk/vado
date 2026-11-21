// One Valkey shard: a Durable Object running valkey.wasm with its AOF in the object's SQLite.
import { DurableObject } from "cloudflare:workers";
import valkeyWasm from "../vendor/valkey.wasm";
import { ValkeyHost } from "./valkey-host.js";
import { command, concat, decodeAll } from "./resp.js";
import { coloOf } from "./pulse.js";
import { Replicator } from "./replication.js";
import { AOF_CHECK_MS, AOF_REWRITE_CAP, AOF_REWRITE_IDLE_MS, AOF_REWRITE_MIN } from "./constants.js";

// Valkey's own config. appendfsync always + the write-through Vfs: a reply leaves only after the
// AOF bytes behind it are in SQLite (the output gate holds it until then).
const valkeyArgs = (env, replica) => [
  "--port", "6379", "--bind", "127.0.0.1", "--protected-mode", "no", "--daemonize", "no",
  "--io-threads", "1", "--logfile", "", "--loglevel", env.VALKEY_LOGLEVEL || "warning",
  "--dir", "/data", "--save", "",
  // A replica keeps its data in memory only: its primary copies it again after a reset.
  ...(replica ? ["--appendonly", "no"] : ["--appendonly", "yes", "--appendfsync", "always", "--appenddirname", "aof"]),
  "--aof-use-rdb-preamble", "yes", "--aof-timestamp-enabled", "no",
  // A rewrite runs inline (no fork in wasm) and blocks the shard, so the shard picks when (#rewriteCheck).
  "--auto-aof-rewrite-percentage", "0",
  // Latency tracking times each command, but the Workers clock doesn't move during one.
  "--latency-tracking", "no",
  "--maxmemory", env.VALKEY_MAXMEMORY || "64mb", "--maxmemory-policy", env.VALKEY_MAXMEMORY_POLICY || "noeviction",
  // Every RPC batch and router socket is a new Valkey connection. The default accepts 10 per event
  // loop cycle, which queued hundreds of RPC batches until callers gave up (seen at 96 x 4 load).
  "--max-new-connections-per-cycle", "1000",
];

// Objects of one class share isolates (and an isolate's memory limit), so stats() says which one this is.
let isolateId = null;

export class ValkeyShard extends DurableObject {
  #host;
  #bornAt = Date.now();
  #instance = crypto.randomUUID();
  #colo; // where this object runs, learned on the first stats() (null until then, or offline)

  #replica; // true for a read replica (named <primary>.r.<region>)
  #ready = false; // a replica serves reads only once its primary's copy has fully arrived
  #repl = null; // a primary's Replicator
  #checkArmed = false; // an alarm will look at the AOF size

  constructor(ctx, env) {
    super(ctx, env);
    this.#replica = /\.r\.[a-z-]+$/.test(ctx.id.name ?? "");
    this.#host = new ValkeyHost(valkeyWasm, ctx.storage.sql, { args: valkeyArgs(env, this.#replica), sync: () => ctx.storage.sync() });
    if (!this.#replica) {
      this.#repl = new Replicator(ctx, env, this.#host, ctx.id.name);
      this.#host.onAppend = (bytes) => { this.#repl.append(bytes); if (!this.#checkArmed) this.#armCheck(); };
    }
  }

  #armCheck() {
    this.#checkArmed = true;
    // The replicator's own tick (every REPL_TICK_MS) also runs the check, so only arm without it.
    if (!this.#repl.configured) queueMicrotask(() => this.ctx.storage.setAlarm(Date.now() + AOF_CHECK_MS));
  }

  // AOF rewrites block the shard while they run, so do them when it's quiet, unless the incr file has
  // grown so big that a restart would take too long to replay it. Returns true if one is still due.
  async #rewriteCheck() {
    if (this.#repl.copying) return true; // a replica copy needs the files to only grow
    const [txt] = decodeAll(await this.#host.execBatch(command(["INFO", "persistence"]), 1));
    const num = (k) => Number(new RegExp(`${k}:(\\d+)`).exec(txt)?.[1] ?? 0);
    const base = num("aof_base_size"), incr = num("aof_current_size") - base;
    const due = incr >= Math.max(AOF_REWRITE_MIN, base) || this.#repl.rdbDue;
    if (incr >= Math.max(AOF_REWRITE_CAP, 2 * base) || (due && Date.now() - this.#host.lastActive >= AOF_REWRITE_IDLE_MS)) {
      await this.#host.execBatch(command(["BGREWRITEAOF"]), 1);
      this.#repl.rdbDue = false;
      return false;
    }
    return due;
  }

  /** Primary: keep read replicas in these regions (Durable Object location hints). */
  replicate(regions) {
    if (this.#replica) throw new Error("a replica can't have replicas");
    this.#repl.configure(regions);
  }

  /** Replica: its primary's copy has arrived; serve reads. Returns where this replica runs. */
  async replicaReady() {
    this.#ready = true;
    return await coloOf().catch(() => null);
  }

  async alarm() {
    if (this.#replica) return;
    await this.#repl.tick();
    this.#checkArmed = false;
    if (await this.#rewriteCheck()) this.#armCheck();
  }

  // TCP: one connection = one Valkey client. Routers dial "router:6379" and get this instance's id
  // as the first frame, so they know exactly which instance accepted the socket (see Upstream.check).
  async connect(socket) {
    const { localAddress } = await socket.opened;
    if (this.#replica) {
      // The primary's stream starts a fresh copy, so stop serving reads until it has arrived.
      if (localAddress?.startsWith("repl")) { this.#ready = false; return await this.#host.serve(socket); }
      if (!this.#ready) return await socket.close(); // the router reads from the primary instead
    }
    await this.#host.serve(socket, localAddress?.startsWith("router") ? `+${this.#instance}\r\n` : null);
  }

  /** Runs commands on a pooled internal client and returns the decoded (RESP2) replies. For fan-out/admin. */
  async run(cmds) {
    return decodeAll(await this.#host.execBatch(concat(cmds.map(command)), cmds.length));
  }

  /** The router's RPC mode: `count` raw RESP requests in, their raw replies out (pooled client).
   *  Without `count` (an older router mid-deploy) it falls back to a throwaway client. */
  async execRaw(bytes, count, proto = 2) {
    if (this.#replica && !this.#ready) throw new Error("replica not ready");
    return count ? await this.#host.execBatch(bytes, count, proto) : await this.#host.exec(bytes);
  }

  /** Like run, but returns the raw reply bytes. */
  async runRaw(cmds) {
    return await this.#host.execBatch(concat(cmds.map(command)), cmds.length);
  }

  /** Identifies this in-memory instance; a reset, eviction or isolate move gives a new one. */
  instance() {
    return this.#instance;
  }

  /** Test hook: how long this object's storage takes to confirm a write (what every reply waits for). */
  async commitProbe(n = 20) {
    const sql = this.ctx.storage.sql, xs = [];
    sql.exec(`CREATE TABLE IF NOT EXISTS commit_probe (k INTEGER PRIMARY KEY, v INTEGER)`);
    for (let i = 0; i < n; i++) {
      const t0 = Date.now(); // Date.now only advances across I/O, which sync() is
      sql.exec(`INSERT OR REPLACE INTO commit_probe VALUES (0, ?)`, i);
      await this.ctx.storage.sync();
      xs.push(Date.now() - t0);
    }
    return { colo: this.#colo, ms: xs.sort((a, b) => a - b) };
  }

  /** Test hook: hard-reset this object (as a crash or deploy would). */
  abort(reason = "test abort") {
    this.ctx.abort(new Error(reason));
  }

  /** stats() plus Valkey's own INFO counters, in one call (the live view polls every shard and replica). */
  async snapshot() {
    const [txt] = await this.run([["INFO", "server", "clients", "memory", "persistence", "stats", "keyspace", "commandstats"]]);
    const info = Object.fromEntries(String(txt).split("\r\n").filter((l) => l.includes(":")).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)]));
    const { files, ...stats } = this.stats();
    return { ...stats, info };
  }

  stats() {
    if (this.#colo === undefined) { this.#colo = null; coloOf().then((c) => { this.#colo = c; }, () => {}); }
    return {
      ...this.#host.stats(), instance: this.#instance, isolate: (isolateId ??= crypto.randomUUID()), colo: this.#colo, aliveSeconds: (Date.now() - this.#bornAt) / 1000, files: this.#host.files(),
      role: this.#replica ? "replica" : "primary", ...(this.#replica ? { ready: this.#ready } : { replicas: this.#repl.status() }),
    };
  }
}
