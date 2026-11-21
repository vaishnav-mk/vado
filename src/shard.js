// One Valkey shard: a Durable Object running valkey.wasm with its AOF in the object's SQLite.
import { DurableObject } from "cloudflare:workers";
import valkeyWasm from "../vendor/valkey.wasm";
import { ValkeyHost } from "./valkey-host.js";
import { command, concat, decodeAll } from "./resp.js";
import { coloOf } from "./pulse.js";
import { Replicator } from "./replication.js";
import { rewriteByHelper } from "./rewriter.js";
import { AOF_CHECK_MS, AOF_HELPER_RETRY_MS, AOF_REWRITE_CAP, AOF_REWRITE_IDLE_MS, AOF_REWRITE_MIN } from "./constants.js";

// Valkey's own config. appendfsync always + the write-through Vfs: a reply leaves only after the
// AOF bytes behind it are in SQLite (the output gate holds it until then).
export const valkeyArgs = (env, replica) => [
  "--port", "6379", "--bind", "127.0.0.1", "--protected-mode", "no", "--daemonize", "no",
  "--io-threads", "1", "--logfile", "", "--loglevel", env.VALKEY_LOGLEVEL || "warning",
  "--dir", "/data", "--save", "",
  // A replica keeps its data in memory only: its primary copies it again after a reset.
  ...(replica ? ["--appendonly", "no"] : ["--appendonly", "yes", "--appendfsync", "always", "--appenddirname", "aof"]),
  "--aof-use-rdb-preamble", "yes", "--aof-timestamp-enabled", "no",
  // No fork in wasm: a rewrite runs in a ValkeyRewriter, or inline (blocking). The shard picks when (#rewriteCheck).
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
  static binding = "SHARD";
  #host;
  #bornAt = Date.now();
  #instance = crypto.randomUUID();
  #colo; // where this object runs, learned on the first stats() (null until then, or offline)

  #replica; // true for a read replica (named <primary>.r.<region>)
  #ready = false; // a replica serves reads only once its primary's copy has fully arrived
  #repl = null; // a primary's Replicator
  #checkArmed = false; // an alarm will look at the AOF size
  #inlineUntil = 0; // after a failed helper rewrite, rewrite inline until then
  #lastRewrite = null; // the last helper rewrite: phase times, bytes, error (in stats())

  constructor(ctx, env) {
    super(ctx, env);
    this.#replica = /\.r\.[a-z-]+$/.test(ctx.id.name ?? "");
    this.#host = new ValkeyHost(valkeyWasm, ctx.storage.sql, { args: valkeyArgs(env, this.#replica), sync: () => ctx.storage.sync() });
    if (!this.#replica) {
      this.#repl = new Replicator(ctx, env, this.#host, ctx.id.name, env[this.constructor.binding]);
      this.#host.onAppend = (bytes) => { this.#repl.append(bytes); if (!this.#checkArmed) this.#armCheck(); };
      if (this.#rewriter()) this.#host.onRewrite = (tmp, rdb) => (this.#helper() ? () => this.#rewriteByHelper(tmp, rdb) : null);
    }
  }

  #armCheck() {
    this.#checkArmed = true;
    // The replicator's own tick (every REPL_TICK_MS) also runs the check, so only arm without it.
    if (!this.#repl.configured) queueMicrotask(() => this.ctx.storage.setAlarm(Date.now() + AOF_CHECK_MS));
  }

  // This shard's rewriter namespace: REWRITER for class SHARD, REWRITERk for SHARDk.
  #rewriter() { return this.env[this.constructor.binding.replace("SHARD", "REWRITER")]; }
  #helper() { return !!this.#rewriter() && Date.now() >= this.#inlineUntil; }

  async #rewriteByHelper(tmp, rdb) {
    const log = (this.#lastRewrite = { at: Date.now(), rdb });
    try {
      await rewriteByHelper(this.#host, this.#rewriter().getByName(this.ctx.id.name), tmp, rdb, () => this.ctx.storage.sync(), log);
      log.ms = Date.now() - log.at;
      return true;
    } catch (e) {
      this.#inlineUntil = Date.now() + AOF_HELPER_RETRY_MS;
      Object.assign(log, { ms: Date.now() - log.at, error: e.message });
      console.log(`rewrite by helper failed after ${log.ms} ms: ${e.message}`);
      return false;
    }
  }

  // Rewrite once the incr file outgrows the base. A rewriter helper doesn't stop the shard; an inline
  // rewrite does, so that waits for a quiet moment, unless the incr file has grown so big that a restart
  // would take too long to replay it. Returns true if one is still due.
  async #rewriteCheck() {
    if (this.#repl.copying || this.#host.rewriting) return true; // a replica copy needs the files to only grow
    const [txt] = decodeAll(await this.#host.execBatch(command(["INFO", "persistence"]), 1));
    const num = (k) => Number(new RegExp(`${k}:(\\d+)`).exec(txt)?.[1] ?? 0);
    const base = num("aof_base_size"), incr = num("aof_current_size") - base;
    const due = incr >= Math.max(AOF_REWRITE_MIN, base) || this.#repl.rdbDue;
    if (incr >= Math.max(AOF_REWRITE_CAP, 2 * base) || (due && (this.#helper() || Date.now() - this.#host.lastActive >= AOF_REWRITE_IDLE_MS))) {
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

  /** Test hook: storage commit times for writing two `mb` MB files, then deleting the first (now in the
   *  middle of the database) and the second (at its end). */
  async vfsProbe(mb = 32) {
    const chunk = crypto.getRandomValues(new Uint8Array(1 << 16)), out = {};
    try { out.autoVacuum = this.ctx.storage.sql.exec("PRAGMA auto_vacuum").toArray(); } catch (e) { out.autoVacuum = e.message; }
    const timed = async (k, f) => { const t = Date.now(); f(); await this.ctx.storage.sync(); out[k] = Date.now() - t; };
    const write = (path) => { for (let i = 0; i < mb * 16; i++) this.#host.appendFile(path, chunk); this.#host.flushFiles(); };
    await timed("writeAMs", () => write("probe-a.bin"));
    await timed("writeBMs", () => write("probe-b.bin"));
    await timed("deleteMiddleMs", () => this.#host.removeFile("probe-a.bin"));
    await timed("deleteEndMs", () => this.#host.removeFile("probe-b.bin"));
    return out;
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
      role: this.#replica ? "replica" : "primary", ...(this.#replica ? { ready: this.#ready } : { replicas: this.#repl.status(), lastRewrite: this.#lastRewrite && { ...this.#lastRewrite, doneMs: this.#host.rewriteDoneMs } }),
    };
  }
}

// The same object under other class names (SHARD_CLASSES in constants.js): see shardNs in index.js.
export class ValkeyShard1 extends ValkeyShard { static binding = "SHARD1"; }
export class ValkeyShard2 extends ValkeyShard { static binding = "SHARD2"; }
export class ValkeyShard3 extends ValkeyShard { static binding = "SHARD3"; }
export class ValkeyShard4 extends ValkeyShard { static binding = "SHARD4"; }
export class ValkeyShard5 extends ValkeyShard { static binding = "SHARD5"; }
export class ValkeyShard6 extends ValkeyShard { static binding = "SHARD6"; }
export class ValkeyShard7 extends ValkeyShard { static binding = "SHARD7"; }
