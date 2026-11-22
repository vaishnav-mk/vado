// One shard: a Durable Object running valkey.wasm (or, for a Redis database, redis.wasm) with its AOF in the
// object's SQLite. Both builds have the same interface, so everything here runs either.
import { DurableObject } from "cloudflare:workers";
import { ValkeyHost } from "./valkey-host.js";
import { command, concat, decodeAll } from "../protocol/resp.js";
import { coloOf } from "../replication/regions.js";
import { replicaBinding, Replicator } from "../replication/replication.js";
import { rewriteByHelper } from "./rewriter.js";
import { flavourOf, WASM } from "./servers.js";
import { AOF_CHECK_MS, AOF_HELPER_RETRY_MS, AOF_REWRITE_CAP, AOF_REWRITE_IDLE_MS, AOF_REWRITE_MIN, deployedAt, RESTARTING, VERSION_CHECK_MS } from "../constants.js";

// Valkey's own config (Redis takes the same). appendfsync always + the write-through Vfs: a reply leaves only after the
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
  // A replica follows its primary, as a Valkey replica does: it neither expires nor evicts keys of its own (the
  // primary's stream deletes them; reads still hide expired keys), and has no memory limit to fail a streamed
  // write on, which with replies off nobody would see. (Redis lacks import-mode; wasm/redis/patches/0005 adds it.)
  // ("3gb" is what 0 means in a 32-bit build, without a warning at every boot.)
  ...(replica ? ["--import-mode", "yes", "--maxmemory", "3gb"] : ["--maxmemory", env.VALKEY_MAXMEMORY || "64mb"]),
  "--maxmemory-policy", env.VALKEY_MAXMEMORY_POLICY || "noeviction",
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
  #flavour; // "valkey" or "redis"
  #ready = false; // a replica serves reads only once its primary's copy has fully arrived, while its stream lasts
  #stream = null; // a replica's current stream from its primary
  #repl = null; // a primary's Replicator
  #checkArmed = false; // an alarm will look at the AOF size
  #inlineUntil = 0; // after a failed helper rewrite, rewrite inline until then
  #lastRewrite = null; // the last helper rewrite: phase times, bytes, error (in stats())

  #dropped; // the database was dropped: storage is gone but this tombstone, and nothing boots
  #restarting = false; // restarting onto newer code (#upgrade): refuses new work
  #rpcs = 0; // RPCs running commands, which a restart lets finish
  #versionCheckAt = 0;

  constructor(ctx, env) {
    super(ctx, env);
    this.#replica = /\.r\.[a-z-]+$/.test(ctx.id.name ?? "");
    this.#dropped = ctx.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dropped'`).toArray().length > 0;
    if (this.#dropped) return;
    this.#flavour = flavourOf(ctx.id.name);
    this.#host = new ValkeyHost(WASM[this.#flavour], ctx.storage.sql, {
      args: valkeyArgs(env, this.#replica), sync: () => ctx.storage.sync(), fatal: (e) => setTimeout(() => ctx.abort(e), 0),
    });
    if (!this.#replica) {
      this.#repl = new Replicator(ctx, env, this.#host, ctx.id.name, env[replicaBinding(Number(this.constructor.binding.slice(5) || 0))]);
      this.#host.onAppend = (bytes) => { this.#repl.append(bytes); if (!this.#checkArmed) this.#armCheck(); };
      this.#host.onInput = () => this.#checkVersion();
      if (this.#rewriter()) this.#host.onRewrite = (tmp, rdb) => (this.#helper() ? () => this.#rewriteByHelper(tmp, rdb) : null);
    }
  }

  #armCheck() {
    this.#checkArmed = true;
    // The replicator's own tick (every REPL_TICK_MS) also runs the check, so only arm without it.
    if (!this.#repl.configured) queueMicrotask(() => this.ctx.storage.setAlarm(Date.now() + AOF_CHECK_MS).catch(() => { this.#checkArmed = false; }));
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
    this.#live();
    if (this.#replica) throw new Error("a replica can't have replicas");
    this.#repl.configure(regions);
  }

  #live() {
    if (this.#dropped) throw new Error("ERR database dropped");
  }

  /** Drops this shard for good: retires its replicas, deletes its storage, and leaves a tombstone so it never
   *  boots again (a router that still knows the database gets errors, not an empty shard). */
  async drop() {
    if (this.#dropped) return;
    this.#dropped = true; // entry points refuse from here
    await this.#repl?.retireAll();
    const sql = this.ctx.storage.sql;
    // The tombstone is stored before anything is deleted, so a reset partway (Valkey writing to a table that
    // is gone resets the object) still leaves a dropped shard, never an empty live one.
    sql.exec(`CREATE TABLE IF NOT EXISTS dropped (at INTEGER NOT NULL)`);
    sql.exec(`INSERT INTO dropped VALUES (?)`, Date.now());
    await this.ctx.storage.sync();
    await this.ctx.storage.deleteAlarm();
    const tables = sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'dropped' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`).toArray();
    for (const { name } of tables) sql.exec(`DROP TABLE "${name}"`);
    await this.ctx.storage.sync();
    setTimeout(() => this.ctx.abort(new Error("dropped")), 0); // Valkey still holds the data in memory; after this returns
  }

  /** Primary: how many replicas have every write made so far (WAIT): once `n` do, or after `ms`. */
  async waitReplicas(n, ms) {
    this.#live();
    if (this.#replica) throw new Error("a replica has no replicas");
    return await this.#repl.wait(n, ms);
  }

  /** Replica: ms since a client last read it (the primary's stream doesn't count). */
  replicaIdleMs() {
    return Date.now() - this.#host.lastActive;
  }

  /** Replica: its primary has stopped streaming to it (dropped it, or went to sleep), so its data only gets
   *  older: stop serving, and reset, which also closes routers' open sockets (their reads go to the primary).
   *  The primary copies a fresh instance when it streams again. */
  retire() {
    this.#ready = false;
    setTimeout(() => this.ctx.abort(new Error("retired by its primary")), 0);
  }

  // Client activity: wakes a primary's replication if it went to sleep.
  #active() {
    this.#host.lastActive = Date.now();
    this.#repl?.wake();
    this.#checkVersion();
  }

  // A busy primary looks for newer code every VERSION_CHECK_MS, by asking its rewriter object, which runs the
  // newest code whenever it starts (it is idle between rewrites).
  #checkVersion() {
    const now = Date.now();
    if (this.#replica || now - this.#versionCheckAt < VERSION_CHECK_MS || !this.#rewriter()) return;
    this.#versionCheckAt = now;
    this.#rewriter().getByName(this.ctx.id.name).deployedAt() // an older rewriter lacks it: the catch
      .then((t) => this.#upgrade(t)).catch((e) => { if (!/deployedAt/.test(e?.message)) console.log(`version check: ${e?.message}`); });
  }

  // Code deployed at `t` is newer: whether to restart onto it now (and if so, from here on this instance is
  // restarting). At most 3 tries per deploy, VERSION_CHECK_MS apart: a restart soon after a deploy can come back on
  // the old code while the deploy is still spreading, and under a gradual deploy this object may keep getting the
  // old code, which must not make it restart forever.
  #restartFor(t) {
    const own = deployedAt(this.env), now = Date.now();
    if (!own || !(t > own) || this.#restarting || this.#dropped) return false;
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS restarts (deployed INTEGER NOT NULL, at INTEGER NOT NULL, report TEXT)`);
    const { n, last } = sql.exec(`SELECT count(*) AS n, max(at) AS last FROM restarts WHERE deployed >= ?`, t).toArray()[0];
    if (n >= 3 || now - (last ?? 0) < VERSION_CHECK_MS) return false;
    sql.exec(`INSERT INTO restarts VALUES (?, ?, NULL)`, t, now);
    this.#restarting = true;
    return true;
  }

  // A primary onto newer code: restart now, cleanly, rather than be reset by the runtime minutes later with
  // commands in flight. Routers that dialed "router-<ms>" get the greeting again before the close, meaning that
  // nothing they got no reply to ran, so they send it again. Its replicas keep serving meanwhile; the next
  // instance copies to them, and they move to its code then (connect()).
  async #upgrade(t) {
    if (this.#replica || !this.#restartFor(t)) return;
    // What the restart took, for the next instance's stats() (the clock moves only across I/O, which each phase is).
    const t0 = Date.now(), report = { from: this.env.VERSION?.id ?? null };
    Object.assign(report, await this.#host.drain(), { drainMs: Date.now() - t0 });
    for (let i = 0; this.#rpcs && i < 500; i++) await new Promise((r) => setTimeout(r, 10));
    report.ms = Date.now() - t0;
    this.ctx.storage.sql.exec(`UPDATE restarts SET report = ? WHERE at = ?`, JSON.stringify(report), t0);
    await this.ctx.storage.sync();
    setTimeout(() => this.ctx.abort(new Error(RESTARTING)), 0);
  }

  // The last restart onto newer code, as the instance that restarted reported it, or null.
  #lastUpgrade() {
    const sql = this.ctx.storage.sql;
    if (!sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'restarts'`).toArray().length) return null;
    const row = sql.exec(`SELECT deployed, at, report FROM restarts ORDER BY at DESC LIMIT 1`).toArray()[0];
    return row ? { deployed: row.deployed, at: row.at, ...JSON.parse(row.report ?? "{}") } : null;
  }

  // RPCs that run commands: refused while restarting (the router tries again on the next instance), and
  // counted, so the restart waits for the ones already running.
  async #rpc(f) {
    this.#live();
    if (this.#restarting) throw new Error(RESTARTING);
    this.#active();
    this.#rpcs++;
    try { return await f(); } finally { this.#rpcs--; }
  }

  /** Replica: its primary's copy has arrived; serve reads. Returns where this replica runs. */
  async replicaReady() {
    if (this.#stream) this.#ready = true; // not if the stream ended meanwhile
    return await coloOf().catch(() => null);
  }

  async alarm() {
    if (this.#replica || this.#dropped) return;
    this.#checkVersion();
    await this.#repl.tick();
    this.#checkArmed = false;
    if (await this.#rewriteCheck()) this.#armCheck();
  }

  // TCP: one connection = one Valkey client. Routers dial "router:6379" and get this instance's id
  // as the first frame, so they know exactly which instance accepted the socket (see Upstream.check).
  async connect(socket) {
    const { localAddress } = await socket.opened;
    if (this.#dropped) {
      const w = socket.writable.getWriter();
      await w.write(new TextEncoder().encode("-ERR database dropped\r\n")).catch(() => {});
      return await w.close().catch(() => {});
    }
    if (this.#replica) {
      // The primary's stream starts a fresh copy, so stop serving reads until it has arrived. A stream that ends
      // here resets the replica, as retire() does: the primary's own close doesn't arrive, so it calls that.
      if (localAddress?.startsWith("repl")) {
        // A primary on newer code: restart onto it first. Its copy fails, and it copies again REPL_RETRY_MS later.
        const from = /^repl-(\d+)/.exec(localAddress);
        if (from && this.#restartFor(Number(from[1]))) {
          await socket.close().catch(() => {});
          await this.ctx.storage.sync();
          return void setTimeout(() => this.ctx.abort(new Error(RESTARTING)), 0);
        }
        this.#stream?.socket.close().catch(() => {}); // from a primary that reset, so never closed it
        const stream = (this.#stream = { socket });
        this.#ready = false;
        try { return await this.#host.serve(socket, null, true); } finally {
          if (this.#stream === stream) { this.#stream = null; this.#ready = false; setTimeout(() => this.ctx.abort(new Error("replica stream ended")), 0); }
        }
      }
      if (!this.#ready) return await socket.close(); // the router reads from the primary instead
    }
    const greeting = localAddress?.startsWith("router") ? `+${this.#instance}\r\n` : null;
    const caller = /^router-(\d+)/.exec(localAddress ?? "");
    if (caller) this.#upgrade(Number(caller[1])).catch((e) => console.log(`upgrade: ${e.stack}`));
    else this.#checkVersion();
    if (this.#restarting) { // nothing runs here any more (set at once by #upgrade): greet and say goodbye
      const w = socket.writable.getWriter();
      if (caller) await w.write(new TextEncoder().encode(greeting + greeting)).catch(() => {});
      return await w.close().catch(() => {});
    }
    this.#repl?.wake();
    await this.#host.serve(socket, greeting, false, caller ? greeting : null);
  }

  /** Runs commands on a pooled internal client and returns the decoded (RESP2) replies. For fan-out/admin. */
  async run(cmds) {
    return await this.#rpc(async () => decodeAll(await this.#host.execBatch(concat(cmds.map(command)), cmds.length)));
  }

  /** The router's RPC mode: `count` raw RESP requests in, their raw replies out (pooled client).
   *  Without `count` (an older router mid-deploy) it falls back to a throwaway client. */
  async execRaw(bytes, count, proto = 2) {
    if (this.#replica && !this.#ready) throw new Error("replica not ready");
    return await this.#rpc(() => (count ? this.#host.execBatch(bytes, count, proto) : this.#host.exec(bytes)));
  }

  /** Like run, but returns the raw reply bytes. */
  async runRaw(cmds) {
    return await this.#rpc(() => this.#host.execBatch(concat(cmds.map(command)), cmds.length));
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

  /** stats() plus Valkey's own INFO counters, in one call. Not client activity: a database that is only
   *  watched (the dashboard polls every shard) still goes to sleep. */
  async snapshot() {
    this.#live();
    const [txt] = decodeAll(await this.#host.execBatch(command(["INFO", "server", "clients", "memory", "persistence", "stats", "keyspace", "commandstats"]), 1));
    const info = Object.fromEntries(String(txt).split("\r\n").filter((l) => l.includes(":")).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)]));
    const stats = this.stats();
    delete stats.files;
    return { ...stats, info };
  }

  stats() {
    if (this.#dropped) return { dropped: true, instance: this.#instance, isolate: (isolateId ??= crypto.randomUUID()), files: [], replicas: [] };
    if (this.#colo === undefined) { this.#colo = null; coloOf().then((c) => { this.#colo = c; }, () => {}); }
    return {
      ...this.#host.stats(), flavour: this.#flavour, instance: this.#instance, version: this.env.VERSION?.id ?? null, isolate: (isolateId ??= crypto.randomUUID()), colo: this.#colo, aliveSeconds: (Date.now() - this.#bornAt) / 1000, restarting: this.#restarting, lastUpgrade: this.#lastUpgrade(), files: this.#host.files(),
      role: this.#replica ? "replica" : "primary", ...(this.#replica ? { ready: this.#ready } : { replicas: this.#repl.status(), lastRewrite: this.#lastRewrite && { ...this.#lastRewrite, doneMs: this.#host.rewriteDoneMs } }),
    };
  }
}

// The same object under other class names (SHARD_CLASSES in constants.js): see shardNs in src/catalog/databases.js.
export class ValkeyShard1 extends ValkeyShard { static binding = "SHARD1"; }
export class ValkeyShard2 extends ValkeyShard { static binding = "SHARD2"; }
export class ValkeyShard3 extends ValkeyShard { static binding = "SHARD3"; }
export class ValkeyShard4 extends ValkeyShard { static binding = "SHARD4"; }
export class ValkeyShard5 extends ValkeyShard { static binding = "SHARD5"; }
export class ValkeyShard6 extends ValkeyShard { static binding = "SHARD6"; }
export class ValkeyShard7 extends ValkeyShard { static binding = "SHARD7"; }
// Read replicas: class 8 + k holds the replicas of class k's shards (replicaBinding in replication.js).
export class ValkeyShard8 extends ValkeyShard { static binding = "SHARD8"; }
export class ValkeyShard9 extends ValkeyShard { static binding = "SHARD9"; }
export class ValkeyShard10 extends ValkeyShard { static binding = "SHARD10"; }
export class ValkeyShard11 extends ValkeyShard { static binding = "SHARD11"; }
export class ValkeyShard12 extends ValkeyShard { static binding = "SHARD12"; }
export class ValkeyShard13 extends ValkeyShard { static binding = "SHARD13"; }
export class ValkeyShard14 extends ValkeyShard { static binding = "SHARD14"; }
export class ValkeyShard15 extends ValkeyShard { static binding = "SHARD15"; }
