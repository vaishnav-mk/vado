// The sharding proxy. One Router per client TCP connection, running in the TCP Worker. It parses
// each request, routes it by key slot to a shard Durable Object over that shard's upstream
// connection, and writes replies back in request order. Clients see one ordinary Valkey.
import { arrayOf, bulk, command, concat, decode, elements, error, frameEnd, integer, lower, request, simple, str } from "./resp.js";
import { keyIndexes } from "./commands.js";
import { shardOfSlot, slotOf } from "./slots.js";

const enc = new TextEncoder();
const OK = simple("OK");
const QUEUED = simple("QUEUED");
const CROSSSLOT = error("CROSSSLOT Keys in request don't hash to the same slot");
const LOST = error("ERR shard connection lost; the command may or may not have run");
const MULTI = command(["MULTI"]);
const EXEC = command(["EXEC"]);
const UNWATCH = command(["UNWATCH"]);
const noop = () => {};
const FAN_OUT = 32;
const HELLO3 = command(["HELLO", "3"]);
const RPC_BATCH_BYTES = 4 << 20; // well under the 32 MiB RPC message cap
// Sockets this isolate holds to shards. The runtime drops sockets past a few hundred per isolate,
// so beyond the budget new upstreams carry stateless batches over RPC instead (RpcUpstream).
let socketsOpen = 0;
let socketBudget = 128;
export const setSocketBudget = (n) => { socketBudget = n; };
const PROBE_AFTER_MS = 5000;
const GREETING_MS = 20000; // a cold shard can take seconds to boot before it greets // a reply this late makes us ask whether the shard instance changed
const HIGH_WATER = 1 << 20; // unacknowledged bytes on any hop before we stop reading the client
const LOW_WATER = 256 << 10;
// All routers in an isolate share its 128 MB: past ISOLATE_HIGH unacknowledged shard-bound bytes in
// total, every router stops reading its client until they drain below ISOLATE_LOW. Shards always
// read, so these drain on their own.
const ISOLATE_HIGH = 32 << 20;
const ISOLATE_LOW = 16 << 20;
let isolateBytes = 0;
const waitingRouters = new Set();
function isolateAdd(n) {
  isolateBytes += n;
  if (n < 0 && isolateBytes <= ISOLATE_LOW && waitingRouters.size) {
    const all = [...waitingRouters];
    waitingRouters.clear();
    for (const r of all) r.wake();
  }
}
const unsupported = (name) => error(`ERR '${name}' is not supported by the sharded router`);
const NOAUTH = error("NOAUTH Authentication required.");
const NULL_ARRAY = new TextEncoder().encode("*-1\r\n"), NULL3 = new TextEncoder().encode("_\r\n"); // EXEC aborted
const WRONGPASS = error("WRONGPASS invalid username-password pair or user is disabled.");
const DB_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const te = new TextEncoder();
// Length leaks; contents don't.
const sameSecret = (a, b) => { const x = te.encode(a), y = te.encode(b); return x.length === y.length && crypto.subtle.timingSafeEqual(x, y); };

const SUBSCRIBE = new Set(["subscribe", "psubscribe", "ssubscribe"]);
const PUBSUB = new Set(["publish", "spublish", "pubsub", "unsubscribe", "punsubscribe", "sunsubscribe", ...SUBSCRIBE]);
const UNSUPPORTED = new Set(["monitor", "sync", "psync", "replicaof", "slaveof", "failover", "shutdown", "debug",
  "migrate", "move", "swapdb", "bgsave", "lpush_x"]);
const BLOCKED_SUB = { client: new Set(["tracking", "caching", "getredir", "trackinginfo", "kill", "pause", "unpause", "unblock", "reply", "list", "no-evict", "no-touch", "capa", "import-source"]) };

function append(a, b) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

class Upstream {
  constructor(router, index, stub) {
    this.router = router;
    this.index = index;
    this.stub = stub;
    this.sent = []; // send times of pending requests, parallel to `pending`
    this.probing = false;
    this.pending = [];
    this.out = [];
    this.scheduled = false;
    this.dead = false;
    this.passthrough = null;
    this.inflight = 0;
    this.lastUsed = router.now;
    // The shard greets a "router" dial with the id of the instance that accepted the socket. If
    // the object is later reset or moved, the runtime may leave this socket open but dead; the
    // watchdog compares that id with the current one to notice. (Asking stub.instance() separately
    // could reach a newer instance than the one holding this socket, and the stall went unseen.)
    this.instanceId = null;
    this.socket = stub.connect("router:6379");
    socketsOpen++;
    this.writer = this.socket.writable.getWriter();
    this.#read();
  }

  // Called by the router's watchdog.
  async check(now) {
    if (this.dead || this.probing || !this.sent.length || now - this.sent[0] < PROBE_AFTER_MS) return;
    this.probing = true;
    try {
      const current = await this.stub.instance();
      // No greeting long after sending means no instance ever served this socket.
      if (this.instanceId === null ? now - this.sent[0] > GREETING_MS : current !== this.instanceId) this.#fail();
    } catch { /* shard unreachable right now: the next check retries */ }
    this.probing = false;
  }

  send(bytes, cb) {
    if (this.dead) return cb(LOST);
    this.pending.push(cb);
    this.sent.push(this.router.now);
    this.raw(bytes);
  }

  // Nothing outstanding and unused for `ms`: the router may close it so the shard can sleep.
  idle(now, ms) {
    return !this.dead && !this.pending.length && !this.out.length && !this.inflight && !this.passthrough && now - this.lastUsed > ms;
  }

  // Bytes whose replies are not matched to callbacks (RESP3 subscribes, passthrough).
  raw(bytes) {
    if (this.dead) return;
    this.lastUsed = this.router.now;
    this.out.push(bytes);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (!this.out.length || this.dead) return;
        const b = concat(this.out); // copy: request bytes may alias the client's read buffer
        this.out = [];
        this.inflight += b.length;
        isolateAdd(b.length);
        this.writer.write(b).then(() => { this.inflight -= b.length; isolateAdd(-b.length); this.router.wake(); }, () => { isolateAdd(-b.length); this.#fail(); });
      });
    }
  }

  async #read() {
    let buf = new Uint8Array(0), start = 0;
    try {
      for await (const chunk of this.socket.readable) {
        buf = start < buf.length ? append(buf.subarray(start), chunk) : chunk;
        start = 0;
        for (let e; (e = frameEnd(buf, start, buf.length)) >= 0; start = e) this.#frame(buf.slice(start, e));
      }
    } catch { /* reset or protocol error: fail below */ }
    this.#fail();
  }

  #frame(f) {
    this.lastUsed = this.router.now;
    if (this.instanceId === null) { this.instanceId = str(f.subarray(1, f.length - 2)); return; } // the greeting
    if (this.passthrough) return this.passthrough(f);
    if (f[0] === 62) return this.router.push(f); // RESP3 push
    const cb = this.pending.shift();
    this.sent.shift();
    if (cb) cb(f);
    else this.router.push(f);
  }

  #fail() {
    if (this.dead) return;
    this.dead = true;
    const pending = this.pending;
    this.pending = [];
    this.sent = [];
    for (const cb of pending) cb(LOST);
    this.socket.close().catch(() => {});
    socketsOpen--;
    this.inflight = 0;
    this.router.wake();
    if (this.passthrough) this.router.endPassthrough(true);
    this.router.dropUpstream(this);
  }

  close() {
    if (!this.dead) socketsOpen--;
    this.dead = true;
    this.socket.close().catch(() => {});
  }
}

// Same interface as Upstream, but each batch is one RPC (shard.execRaw) on a throwaway Valkey
// client. One batch in flight at a time keeps this connection's commands in order. Not used for
// WATCH or pub/sub, which need a real connection.
class RpcUpstream {
  constructor(router, index, stub) {
    this.router = router;
    this.index = index;
    this.stub = stub;
    this.pending = [];
    this.out = [];
    this.outBytes = 0;
    this.busy = false;
    this.scheduled = false;
    this.dead = false;
    this.inflight = 0;
    this.passthrough = null;
    this.sent = [];
  }
  // Queued bytes count as in flight from the moment they are queued: with one batch at a time, a
  // slow or cold shard would otherwise let the router keep reading clients and queue here without
  // bound until the isolate ran out of memory (seen as Worker error 1102 under load).
  send(bytes, cb) {
    this.pending.push(cb);
    this.out.push(bytes.slice());
    this.outBytes += bytes.length;
    this.inflight += bytes.length;
    isolateAdd(bytes.length);
    this.#schedule();
  }
  raw(bytes) { this.send(bytes, noop); }
  #schedule() {
    if (this.scheduled || this.busy) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.#flush(); });
  }
  #flush() {
    if (this.busy || !this.out.length) return;
    // Take whole requests up to the batch cap.
    let take = 0, bytes = 0;
    while (take < this.out.length && (take === 0 || bytes + this.out[take].length <= RPC_BATCH_BYTES)) bytes += this.out[take++].length;
    const cbs = this.pending.splice(0, take), parts = this.out.splice(0, take);
    this.outBytes -= bytes;
    const body = concat(parts);
    this.busy = true;
    const done = () => { this.busy = false; this.inflight -= bytes; isolateAdd(-bytes); this.router.wake(); this.#schedule(); };
    this.stub.execRaw(body, cbs.length, this.router.proto).then((reply) => {
      let i = 0;
      for (const cb of cbs) {
        const e = i < 0 ? -1 : frameEnd(reply, i, reply.length);
        if (e < 0) { cb(LOST); continue; }
        cb(reply.slice(i, e));
        i = e;
      }
      done();
    }, () => {
      // A stub whose object was reset stays broken: drop this upstream so the next command gets a
      // fresh stub (socket upstreams already do this when their socket fails).
      this.dead = true;
      for (const cb of cbs) cb(LOST);
      done();
    });
  }
  check() {}
  idle() { return false; }
  close() { this.dead = true; }
}

export class Router {
  #ups = new Map(); // shard index (or "pubsub") -> Upstream
  #queue = []; // reply slots in request order: { b: Uint8Array | null }
  #pushes = []; // passthrough frames waiting for the queue to drain
  #writer;
  #closed = false;
  proto = 2;
  #name = null;
  #multi = null; // { cmds: Uint8Array[], shard: number | null, failed: boolean }
  #watch = null; // shard index pinned by WATCH
  #watchUp = null; // the upstream (one Valkey connection) holding the WATCH
  #watchBroken = false; // that connection died: the shard forgot the WATCH, so EXEC must abort
  #pass = null; // RESP2 pub/sub passthrough: the pubsub Upstream
  static #ids = 0;
  #id = ++Router.#ids;
  #inflight = 0; // reply bytes written to the client and not yet acknowledged
  #flushing = false;
  now = Date.now(); // coarse clock for the watchdog, refreshed every tick
  #waiter = null;

  #password; // undefined: no AUTH required
  #open; // (name) => Promise<{ db, shard, pubsub }>
  #authed;
  #pending = null; // later requests wait for this (an AUTH switching databases, an RPC-path command)
  #onHead = new Map(); // reply slot -> wake, for RPC-path commands waiting on every earlier reply
  #idleMs;

  constructor(socket, { db, table, shard, pubsub, password, open, idleMs = 30000 }) {
    this.socket = socket;
    this.db = db; // { name, created, shards }
    this.table = table;
    this.shardStub = shard; // (i) => stub
    this.pubsubStub = pubsub; // () => stub
    this.#password = password || undefined;
    this.#open = open;
    this.#authed = !this.#password;
    this.#idleMs = idleMs;
    this.#writer = socket.writable.getWriter();
  }

  #blocked() {
    if (isolateBytes > ISOLATE_HIGH) { waitingRouters.add(this); return true; }
    if (this.#inflight > HIGH_WATER) return true;
    for (const up of this.#ups.values()) if (up.inflight > HIGH_WATER) return true;
    return false;
  }
  wake() {
    if (!this.#waiter) return;
    if (isolateBytes > ISOLATE_HIGH) { waitingRouters.add(this); return; }
    if (this.#inflight > LOW_WATER) return;
    for (const up of this.#ups.values()) if (up.inflight > LOW_WATER) return;
    const w = this.#waiter;
    this.#waiter = null;
    w();
  }

  async run() {
    let buf = new Uint8Array(0), start = 0;
    const reader = this.socket.readable.getReader();
    const watchdog = setInterval(() => {
      this.now = Date.now();
      for (const [i, up] of this.#ups) {
        up.check(this.now);
        // Close shard sockets nobody is using, so idle shards stop being billed and can sleep.
        if (i !== "pubsub" && i !== this.#watch && !this.#multi && up.idle(this.now, this.#idleMs)) { up.close(); this.#ups.delete(i); }
      }
    }, 2000);
    try {
      for (;;) {
        while (this.#blocked() && !this.#closed) await new Promise((r) => { this.#waiter = r; });
        const { value: chunk, done } = await reader.read();
        if (done) break;
        buf = start < buf.length ? append(buf.subarray(start), chunk) : chunk;
        start = 0;
        for (let r; !this.#closed && (r = request(buf, start, buf.length)); start = r.end) {
          if (this.#pending) await this.#pending;
          if (r.argv.length) this.#handle(r.argv, buf.subarray(start, r.end));
        }
        if (this.#closed) break;
      }
    } catch (e) {
      this.#write(error(`ERR ${e.message}`));
    }
    await this.#drain();
    clearInterval(watchdog);
    for (const up of this.#ups.values()) up.close();
    await this.#writer.close().catch(() => {});
  }

  // ---- output ----
  #slot() { const s = { b: null }; this.#queue.push(s); return s; }
  #resolve(s, b) { s.b = b; this.#flush(); }
  #reply(b) { this.#resolve(this.#slot(), b); }
  // Replies are written once per microtask, not once per reply: a pipelined batch is one write.
  #flush() {
    if (this.#flushing) return;
    this.#flushing = true;
    queueMicrotask(() => {
      this.#flushing = false;
      const parts = [];
      let n = 0;
      while (n < this.#queue.length && this.#queue[n].b) parts.push(this.#queue[n++].b);
      if (n) this.#queue.splice(0, n);
      const wake = this.#onHead.get(this.#queue[0]);
      if (wake) { this.#onHead.delete(this.#queue[0]); wake(); }
      if (!this.#queue.length && this.#pushes.length) { parts.push(...this.#pushes); this.#pushes = []; }
      if (parts.length) this.#write(parts.length === 1 ? parts[0] : concat(parts));
    });
  }
  // Client-bound bytes stay out of the isolate budget: they drain only if that client reads, and a
  // client blocked writing its pipeline doesn't read, so counting them would let one stalled client
  // pause every router in the isolate. They're bounded per connection by HIGH_WATER instead.
  #write(b) {
    this.#inflight += b.length;
    this.#writer.write(b).then(() => { this.#inflight -= b.length; this.wake(); }, () => { this.#closed = true; this.#waiter?.(); });
  }
  push(f) {
    if (this.#queue.length) this.#pushes.push(f.slice());
    else this.#write(f.slice());
  }
  async #drain() {
    for (let i = 0; this.#queue.length && i < 600; i++) await new Promise((r) => setTimeout(r, 100));
  }

  // ---- upstreams ----
  #up(i, needsSocket = false) {
    let up = this.#ups.get(i);
    if (up && !up.dead && (!needsSocket || up instanceof Upstream)) return up;
    const stub = i === "pubsub" ? this.pubsubStub() : this.shardStub(i);
    const socket = needsSocket || i === "pubsub" || socketsOpen < socketBudget;
    up = socket ? new Upstream(this, i, stub) : new RpcUpstream(this, i, stub);
    this.#ups.set(i, up);
    if (socket && this.proto === 3) up.send(HELLO3, noop);
    if (socket && this.#name) up.send(command(["CLIENT", "SETNAME", this.#name]), noop);
    return up;
  }
  dropUpstream(up) {
    if (this.#ups.get(up.index) === up) this.#ups.delete(up.index);
    // A reset shard forgot the WATCH. Keep #watch set so the next EXEC knows it was watched and
    // aborts (null reply, as on a conflict) instead of running unconditionally on a new instance.
    if (up === this.#watchUp) this.#watchBroken = true;
  }
  #forward(i, raw, retryable = false) {
    const s = this.#slot();
    // Read-only, non-blocking commands are retried once on a fresh upstream if the shard was
    // reset under them; anything else gets LOST (it may have run).
    const copy = retryable ? raw.slice() : null;
    this.#up(i).send(raw, (f) => {
      if (f === LOST && copy) return this.#up(i).send(copy, (g) => this.#resolve(s, g));
      this.#resolve(s, f);
    });
  }

  // ---- routing ----
  #shardsOf(keys) {
    const N = this.db.shards;
    const slot = slotOf(keys[0]);
    for (let k = 1; k < keys.length; k++) if (slotOf(keys[k]) !== slot) return -1;
    return shardOfSlot(slot, N);
  }

  #arity(name, argv) {
    const e = this.table.get(name);
    if (!e) {
      // Valkey's own wording (processCommand): original spelling, each arg as '%.*s' plus a space, up to 128 chars.
      let args = "";
      for (let i = 1; i < argv.length && args.length < 128; i++) args += `'${str(argv[i]).slice(0, 128 - args.length)}' `;
      return error(`ERR unknown command '${str(argv[0]).slice(0, 128)}', with args beginning with: ${args}`.replace(/[\r\n]/g, " "));
    }
    if ((e.arity > 0 && argv.length !== e.arity) || (e.arity < 0 && argv.length < -e.arity)) {
      return error(`ERR wrong number of arguments for '${name}' command`);
    }
    return null;
  }

  #handle(argv, raw) {
    if (this.#pass) return this.#passRequest(argv, raw);
    const name = lower(argv[0]);
    if (!this.#authed && name !== "auth" && name !== "hello" && name !== "quit") return this.#reply(NOAUTH);
    if (this.#multi && !["exec", "discard", "multi", "watch", "quit", "reset"].includes(name)) return this.#queueTx(name, argv, raw);
    switch (name) {
      case "ping": return this.#reply(argv.length > 1 ? bulk(argv[1]) : simple("PONG"));
      case "echo": return this.#reply(argv.length === 2 ? bulk(argv[1]) : error("ERR wrong number of arguments for 'echo' command"));
      case "quit": this.#reply(OK); this.#closed = true; return;
      case "select": return this.#reply(str(argv[1] ?? "") === "0" ? OK : error("ERR DB index is out of range (use one database name per connection address)"));
      case "auth":
        if (argv.length !== 2 && argv.length !== 3) return this.#reply(error("ERR wrong number of arguments for 'auth' command"));
        return this.#login(argv.length === 3 ? str(argv[1]) : null, str(argv[argv.length - 1]), () => this.#reply(OK));
      case "readonly": case "readwrite": return this.#reply(OK);
      case "hello": return this.#hello(argv);
      case "client": return this.#client(argv);
      case "reset": return this.#reset();
      case "multi":
        if (this.#multi) return this.#reply(error("ERR MULTI calls can not be nested"));
        this.#multi = { cmds: [], shard: this.#watch, watched: this.#watch !== null, failed: false };
        return this.#reply(OK);
      case "exec": return this.#exec();
      case "discard": return this.#discard();
      case "watch": return this.#watchCmd(argv, raw);
      case "unwatch":
        if (this.#watch === null) return this.#reply(OK);
        if (this.#watchBroken) { this.#clearWatch(); return this.#reply(OK); }
        this.#forward(this.#watch, raw);
        this.#clearWatch();
        return;
      case "wait": return this.#reply(integer(0));
      case "waitaof": return this.#reply(arrayOf([integer(1), integer(0)]));
      case "cluster": return this.#cluster(argv);
      case "dbsize": return this.#fanout(argv, (rs) => integer(rs.reduce((n, r) => n + r, 0)));
      case "keys": return this.#fanoutRaw(argv, (frames) => arrayOf(frames.flatMap((f) => elements(f))));
      case "flushall": case "flushdb": return this.#fanout(argv, (rs) => rs.find((r) => r?.err) ? error(rs.find((r) => r?.err).err) : OK);
      case "scan": return this.#scan(argv);
      case "randomkey": return this.#randomkey();
      case "info": return this.#info(argv);
      case "script": return this.#scriptOrFunction(argv, raw);
      case "function": return this.#scriptOrFunction(argv, raw);
      case "config":
        if (lower(argv[1] ?? new Uint8Array()) === "set" || lower(argv[1] ?? new Uint8Array()) === "resetstat") {
          return this.#fanout(argv, (rs) => rs.find((r) => r?.err) ? error(rs.find((r) => r?.err).err) : OK);
        }
        return this.#forward(0, raw);
      case "save": case "bgrewriteaof": return this.#fanout(argv, (rs) => rs.find((r) => r?.err) ? error(rs.find((r) => r?.err).err) : simple(name === "save" ? "OK" : "Background append only file rewriting started"));
    }
    if (UNSUPPORTED.has(name)) return this.#reply(unsupported(name));
    if (PUBSUB.has(name)) return this.#pubsub(name, argv, raw);
    const bad = this.#arity(name, argv);
    if (bad) return this.#reply(bad);
    const idx = keyIndexes(this.table, name, argv);
    if (idx === null) return this.#getkeys(name, argv, raw);
    this.#routeKeys(name, argv, raw, idx.map((i) => argv[i]));
  }

  #retryable(name) {
    const f = this.table.get(name)?.flags;
    return !!f && f.has("readonly") && !f.has("blocking") && !this.#multi && this.#watch === null;
  }

  #routeKeys(name, argv, raw, keys) {
    if (!keys.length || this.db.shards === 1) return this.#forward(0, raw, this.#retryable(name));
    const shard = this.#shardsOf(keys);
    if (shard >= 0) return this.#forward(shard, raw, this.#retryable(name));
    switch (name) {
      case "mget": return this.#mget(argv);
      case "mset": return this.#mset(argv);
      case "del": case "unlink": case "exists": case "touch": return this.#sumSplit(name, argv);
    }
    this.#reply(CROSSSLOT);
  }

  // Unknown key positions: ask Valkey, then route. Ordering is kept by reserving the reply slot first.
  #getkeys(name, argv, raw) {
    const s = this.#slot();
    const copy = raw.slice();
    // Later requests wait until this one is sent, so it runs before them on its shard.
    this.#hold(this.shardStub(0).run([["COMMAND", "GETKEYS", ...argv.map(str)]]).then(([keys]) => {
      if (keys?.err) return this.#resolve(s, error(keys.err));
      const ks = (keys ?? []).map((k) => enc.encode(k));
      const shard = !ks.length || this.db.shards === 1 ? 0 : this.#shardsOf(ks);
      if (shard < 0) return this.#resolve(s, CROSSSLOT);
      this.#up(shard).send(copy, (f) => this.#resolve(s, f));
    }, (e) => this.#resolve(s, error(`ERR ${e.message}`))));
  }

  #groups(keys, step = 1) {
    const N = this.db.shards, groups = new Map();
    for (let i = 0; i < keys.length; i += step) {
      const g = shardOfSlot(slotOf(keys[i]), N);
      let list = groups.get(g);
      if (!list) groups.set(g, (list = []));
      list.push(i);
    }
    return groups;
  }

  #mget(argv) {
    const keys = argv.slice(1), s = this.#slot(), out = new Array(keys.length), groups = this.#groups(keys);
    let left = groups.size, failed = null;
    for (const [g, idx] of groups) {
      this.#up(g).send(command(["MGET", ...idx.map((i) => keys[i])]), (f) => {
        if (f[0] === 45) failed ??= f;
        else elements(f).forEach((e, k) => { out[idx[k]] = e; });
        if (--left === 0) this.#resolve(s, failed ?? arrayOf(out));
      });
    }
  }

  #mset(argv) {
    const args = argv.slice(1);
    if (args.length % 2) return this.#reply(error("ERR wrong number of arguments for 'mset' command"));
    const s = this.#slot(), groups = this.#groups(args, 2);
    let left = groups.size, failed = null;
    for (const [g, idx] of groups) {
      this.#up(g).send(command(["MSET", ...idx.flatMap((i) => [args[i], args[i + 1]])]), (f) => {
        if (f[0] === 45) failed ??= f;
        if (--left === 0) this.#resolve(s, failed ?? OK);
      });
    }
  }

  #sumSplit(name, argv) {
    const keys = argv.slice(1), s = this.#slot(), groups = this.#groups(keys);
    let left = groups.size, sum = 0, failed = null;
    for (const [g, idx] of groups) {
      this.#up(g).send(command([name.toUpperCase(), ...idx.map((i) => keys[i])]), (f) => {
        if (f[0] === 45) failed ??= f;
        else sum += decode(f)[0];
        if (--left === 0) this.#resolve(s, failed ?? integer(sum));
      });
    }
  }

  // ---- transactions: queued here, sent to one shard at EXEC ----
  #queueTx(name, argv, raw) {
    const m = this.#multi;
    const bad = this.#arity(name, argv);
    if (bad) { m.failed = true; return this.#reply(bad); }
    if (PUBSUB.has(name) || UNSUPPORTED.has(name)) { m.failed = true; return this.#reply(unsupported(`${name} in MULTI`)); }
    const idx = keyIndexes(this.table, name, argv);
    if (idx === null) { m.failed = true; return this.#reply(unsupported(`${name} in MULTI`)); }
    if (idx.length && this.db.shards > 1) {
      const shard = this.#shardsOf(idx.map((i) => argv[i]));
      if (shard < 0 || (m.shard !== null && m.shard !== shard)) { m.failed = true; return this.#reply(CROSSSLOT); }
      m.shard = shard;
    }
    m.cmds.push(raw.slice());
    this.#reply(QUEUED);
  }

  #clearWatch() {
    this.#watch = null;
    this.#watchUp = null;
    this.#watchBroken = false;
  }

  #exec() {
    const m = this.#multi;
    if (!m) return this.#reply(error("ERR EXEC without MULTI"));
    this.#multi = null;
    const watchUp = this.#watchUp, broken = m.watched && (this.#watchBroken || !watchUp || watchUp.dead);
    this.#clearWatch();
    if (m.failed) return this.#reply(error("EXECABORT Transaction discarded because of previous errors."));
    if (broken) return this.#reply(this.proto === 3 ? NULL3 : NULL_ARRAY);
    const s = this.#slot(), up = m.watched ? watchUp : this.#up(m.shard ?? 0);
    up.send(MULTI, noop);
    for (const c of m.cmds) up.send(c, noop);
    up.send(EXEC, (f) => this.#resolve(s, f));
  }

  #discard() {
    if (!this.#multi) return this.#reply(error("ERR DISCARD without MULTI"));
    this.#multi = null;
    if (this.#watch !== null && !this.#watchBroken) this.#up(this.#watch).send(UNWATCH, noop);
    this.#clearWatch();
    this.#reply(OK);
  }

  #watchCmd(argv, raw) {
    if (this.#multi) return this.#reply(error("ERR WATCH inside MULTI is not allowed"));
    if (argv.length < 2) return this.#reply(error("ERR wrong number of arguments for 'watch' command"));
    const shard = this.db.shards === 1 ? 0 : this.#shardsOf(argv.slice(1));
    if (shard < 0 || (this.#watch !== null && this.#watch !== shard)) return this.#reply(CROSSSLOT);
    this.#watch = shard;
    const s = this.#slot(), up = this.#up(shard, true);
    if (this.#watchUp && this.#watchUp !== up) this.#watchBroken = true; // earlier keys were watched on a connection that died
    this.#watchUp = up;
    up.send(raw, (f) => this.#resolve(s, f));
  }

  // ---- pub/sub: one pubsub object per database ----
  #pubsub(name, argv, raw) {
    if (!SUBSCRIBE.has(name) && !name.endsWith("unsubscribe")) return this.#forward("pubsub", raw);
    const up = this.#up("pubsub");
    if (this.proto === 3) return up.raw(raw.slice()); // confirmations and messages arrive as pushes
    if (name.endsWith("unsubscribe")) return this.#reply(arrayOf([bulk(name), bulk(null), integer(0)]));
    // RESP2: the connection becomes a pipe to the pubsub object until it unsubscribes from everything.
    this.#pass = up;
    up.passthrough = (f) => {
      this.push(f);
      if (f[0] === 43 && str(f).startsWith("+RESET")) return this.endPassthrough(false);
      if (f[0] !== 42) return;
      const [v] = decode(f);
      if (Array.isArray(v) && typeof v[0] === "string" && v[0].endsWith("unsubscribe") && v[2] === 0) this.endPassthrough(false);
    };
    up.raw(raw.slice());
  }

  #passRequest(argv, raw) {
    const name = lower(argv[0]);
    if (!PUBSUB.has(name) && !["ping", "quit", "reset"].includes(name)) {
      return this.push(error(`ERR Can't execute '${name}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context`));
    }
    if (name === "quit") { this.push(OK); this.#closed = true; return; }
    this.#pass.raw(raw.slice());
  }

  endPassthrough(lost) {
    if (!this.#pass) return;
    this.#pass.passthrough = null;
    this.#pass = null;
    if (lost) this.push(LOST);
  }

  // ---- connection state ----
  #hello(argv) {
    let proto = this.proto;
    if (argv.length > 1) {
      proto = Number(str(argv[1]));
      if (proto !== 2 && proto !== 3) return this.#reply(error("NOPROTO unsupported protocol version"));
    }
    let user = null, pass = null, setname = null;
    for (let i = 2; i < argv.length; i++) {
      const opt = lower(argv[i]);
      if (opt === "auth") { user = str(argv[i + 1] ?? new Uint8Array()); pass = str(argv[i + 2] ?? new Uint8Array()); i += 2; }
      else if (opt === "setname") setname = str(argv[++i] ?? new Uint8Array());
    }
    if (pass !== null) return this.#login(user, pass, () => this.#helloAs(proto, setname));
    if (!this.#authed) return this.#reply(error("NOAUTH HELLO must be called with the client already authenticated, otherwise the HELLO <proto> AUTH <user> <pass> option can be used to authenticate the client and select the RESP protocol version at the same time"));
    this.#helloAs(proto, setname);
  }

  #helloAs(proto, setname) {
    if (setname !== null) this.#name = setname;
    const changed = proto !== this.proto;
    this.proto = proto;
    if (changed) for (const [i, up] of this.#ups) if (i !== 0) up.send(command(["HELLO", String(proto)]), noop);
    this.#forward(0, command(["HELLO", String(proto)]));
  }

  // AUTH [user] pass. With VALKEY_PASSWORD set the password must match; `user` names the database
  // ("default" keeps the one chosen by the dialed host), since one shared secret guards them all.
  // Database lookup is async, so requests after this wait (run() awaits #pending) to keep order.
  #login(user, pass, then) {
    if (this.#password !== undefined && !sameSecret(pass, this.#password)) return this.#reply(WRONGPASS);
    if (!user || user === "default" || user === this.db.name) { this.#authed = true; return then(); }
    if (!DB_NAME.test(user)) return this.#reply(error("ERR database names are 1-64 characters of A-Z a-z 0-9 _ . -"));
    this.#pending = this.#open(user).then((next) => {
      for (const up of this.#ups.values()) up.close();
      this.#ups.clear();
      this.#clearWatch();
      this.endPassthrough(false);
      Object.assign(this, { db: next.db, shardStub: next.shard, pubsubStub: next.pubsub });
      this.#authed = true;
      then();
    }, (e) => this.#reply(error(`ERR ${e.message}`))).finally(() => { this.#pending = null; });
  }

  #client(argv) {
    const sub = lower(argv[1] ?? new Uint8Array());
    switch (sub) {
      case "setname":
        this.#name = str(argv[2] ?? new Uint8Array());
        for (const up of this.#ups.values()) up.send(command(["CLIENT", "SETNAME", this.#name]), noop);
        return this.#reply(OK);
      case "getname": return this.#reply(bulk(this.#name));
      case "id": return this.#reply(integer(this.#id));
      case "setinfo": return this.#reply(OK);
      case "info": return this.#reply(bulk(`id=${this.#id} name=${this.#name ?? ""} db=0 resp=${this.proto} router=1 shards=${this.db.shards}\n`));
    }
    if (BLOCKED_SUB.client.has(sub)) return this.#reply(unsupported(`client ${sub}`));
    return this.#reply(error(`ERR unknown subcommand '${sub}'`));
  }

  #reset() {
    this.#multi = null;
    this.#clearWatch();
    this.#name = null;
    this.proto = 2;
    this.endPassthrough(false);
    for (const up of this.#ups.values()) up.close();
    this.#ups.clear();
    this.#reply(simple("RESET"));
  }

  #cluster(argv) {
    const sub = lower(argv[1] ?? new Uint8Array());
    if (sub === "keyslot" && argv[2]) return this.#reply(integer(slotOf(argv[2])));
    if (sub === "info") return this.#reply(bulk(`cluster_enabled:0\r\nrouter_shards:${this.db.shards}\r\n`));
    return this.#reply(error("ERR This instance has cluster support disabled (sharding is done by the router)"));
  }

  // ---- ordering for commands that go by RPC instead of the connection's shard sockets ----
  // Sockets keep per-shard order on their own; RPCs don't. So an RPC-path command first waits for
  // every earlier reply (DBSIZE after a DEL must see it), and later requests wait for it (a SET
  // after FLUSHALL must not run first). Found by differential testing against real Valkey.
  #afterEarlierReplies(s) {
    return this.#queue[0] === s ? Promise.resolve() : new Promise((r) => this.#onHead.set(s, r));
  }
  #hold(p) {
    const held = p.catch(() => {}).finally(() => { if (this.#pending === held) this.#pending = null; });
    this.#pending = held;
  }

  // ---- fan-out over every shard, via RPC (no upstream connections held) ----
  // At most FAN_OUT shards at a time, answers in shard order.
  async #all(cmds, raw) {
    const N = this.db.shards, out = new Array(N);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < N; i = next++) out[i] = await (raw ? this.shardStub(i).runRaw(cmds) : this.shardStub(i).run(cmds));
    };
    await Promise.all(Array.from({ length: Math.min(FAN_OUT, N) }, worker));
    return out;
  }
  #fanout(argv, merge) {
    const s = this.#slot();
    this.#hold(this.#afterEarlierReplies(s).then(() => this.#all([argv.map(str)], false))
      .then((rs) => this.#resolve(s, merge(rs.map((r) => r[0]))), (e) => this.#resolve(s, error(`ERR ${e.message}`))));
  }
  #fanoutRaw(argv, merge) {
    const s = this.#slot();
    this.#hold(this.#afterEarlierReplies(s).then(() => this.#all([argv.map(str)], true)).then((rs) => {
      const bad = rs.find((r) => r[0] === 45);
      this.#resolve(s, bad ?? merge(rs));
    }, (e) => this.#resolve(s, error(`ERR ${e.message}`))));
  }

  // SCAN cursor = inner cursor * shards + shard index, so it stays one integer.
  #scan(argv) {
    const N = BigInt(this.db.shards);
    let cursor;
    try { cursor = BigInt(str(argv[1] ?? new Uint8Array())); } catch { return this.#reply(error("ERR invalid cursor")); }
    const shard = Number(cursor % N), inner = cursor / N;
    const s = this.#slot();
    this.#hold(this.#afterEarlierReplies(s).then(() => this.shardStub(shard).runRaw([["SCAN", inner.toString(), ...argv.slice(2).map(str)]])).then((f) => {
      if (f[0] === 45) return this.#resolve(s, f);
      const [next, keys] = elements(f);
      const innerNext = BigInt(decode(next)[0]);
      const composite = innerNext !== 0n ? innerNext * N + BigInt(shard) : BigInt(shard + 1) < N ? BigInt(shard + 1) : 0n;
      this.#resolve(s, arrayOf([bulk(composite.toString()), keys]));
    }, (e) => this.#resolve(s, error(`ERR ${e.message}`))));
  }

  #randomkey() {
    const s = this.#slot(), N = this.db.shards, start = Math.floor(Math.random() * N);
    const tryShard = async (k) => {
      for (; k < N; k++) {
        const [key] = await this.shardStub((start + k) % N).run([["RANDOMKEY"]]);
        if (key !== null) return this.#resolve(s, bulk(key));
      }
      this.#resolve(s, bulk(null));
    };
    this.#hold(this.#afterEarlierReplies(s).then(() => tryShard(0)).catch((e) => this.#resolve(s, error(`ERR ${e.message}`))));
  }

  #info(argv) {
    const s = this.#slot();
    const section = argv.slice(1).map(str);
    this.#hold(this.#afterEarlierReplies(s).then(() => Promise.all([this.shardStub(0).run([["INFO", ...section]]), this.#all([["INFO", "keyspace"]], false)])).then(([[head], spaces]) => {
      let keys = 0, expires = 0;
      for (const [txt] of spaces) {
        const m = /db0:keys=(\d+),expires=(\d+)/.exec(txt ?? "");
        if (m) { keys += Number(m[1]); expires += Number(m[2]); }
      }
      const body = String(head ?? "").replace(/# Keyspace\r\n(db\d+:[^\r]*\r\n)*/, "") +
        `# Keyspace\r\n${keys ? `db0:keys=${keys},expires=${expires},avg_ttl=0\r\n` : ""}` +
        `\r\n# Router\r\nrouter_db:${this.db.name}\r\nrouter_shards:${this.db.shards}\r\n`;
      this.#resolve(s, bulk(body));
    }, (e) => this.#resolve(s, error(`ERR ${e.message}`))));
  }

  // SCRIPT LOAD/FLUSH and FUNCTION LOAD/DELETE/FLUSH/RESTORE go to every shard, so EVALSHA and
  // FCALL work wherever their keys land. SCRIPT EXISTS is true only if every shard has the script.
  #scriptOrFunction(argv, raw) {
    const sub = lower(argv[1] ?? new Uint8Array());
    const everywhere = argv[0] && lower(argv[0]) === "script" ? ["load", "flush"] : ["load", "delete", "flush", "restore"];
    if (lower(argv[0]) === "script" && sub === "exists") {
      return this.#fanout(argv, (rs) => {
        const bad = rs.find((r) => r?.err);
        if (bad) return error(bad.err);
        return arrayOf(rs[0].map((_, i) => integer(rs.every((r) => r[i] === 1) ? 1 : 0)));
      });
    }
    if (!everywhere.includes(sub)) return this.#forward(0, raw);
    this.#fanoutRaw(argv, (frames) => frames[0]);
  }
}
