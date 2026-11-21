// Tests and limit probes that run inside Cloudflare. Clients speak RESP over TCP sockets:
//   via=router (default)  service binding connect("<db>:6379") -> TCP Worker -> Router -> shards
//   via=shard             one shard's DO connect() directly (shard=<i>), no router
import { configureReplicas, database, replicaStub, shardStub } from "./index.js";
import Redis from "ioredis";
import { bindingConnector } from "./client.js";
import { sameSecret } from "./router.js";
import { HINTS, WORLD } from "./catalog.js";

const enc = new TextEncoder();
const cmd = (...a) => `*${a.length}\r\n` + a.map((x) => ((x = String(x)), `$${enc.encode(x).length}\r\n${x}\r\n`)).join("");

function parse(s, i) {
  const e = s.indexOf("\r\n", i);
  if (e < 0) return null;
  const t = s[i], line = s.slice(i + 1, e);
  if (t === "+") return [line, e + 2];
  if (t === "-") return [{ err: line }, e + 2];
  if (t === ":") return [Number(line), e + 2];
  if (t === "$" || t === "*") {
    const n = Number(line);
    if (n < 0) return [null, e + 2];
    if (t === "$") return s.length < e + 4 + n ? null : [s.slice(e + 2, e + 2 + n), e + 4 + n];
    const arr = [];
    let j = e + 2;
    for (let k = 0; k < n; k++) { const r = parse(s, j); if (!r) return null; arr.push(r[0]); j = r[1]; }
    return [arr, j];
  }
  throw new Error(`bad RESP type ${JSON.stringify(t)}`);
}

export class Resp {
  constructor(socket, stallMs = 30000) {
    this.w = socket.writable.getWriter();
    this.r = socket.readable.getReader();
    this.dec = new TextDecoder();
    this.buf = "";
    this.stallMs = stallMs;
  }
  async call(...cmds) {
    await this.w.write(enc.encode(cmds.map((c) => cmd(...c)).join("")));
    return this.read(cmds.length);
  }
  async read(n) {
    const out = [];
    let pos = 0;
    while (out.length < n) {
      const r = pos < this.buf.length ? parse(this.buf, pos) : null;
      if (r) { out.push(r[0]); pos = r[1]; continue; }
      let timer;
      const stall = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`stalled ${this.stallMs / 1000}s waiting for reply ${out.length + 1}/${n}`)), this.stallMs); });
      const { value, done } = await Promise.race([this.r.read(), stall]).finally(() => clearTimeout(timer));
      if (done) throw new Error(`connection closed after ${out.length}/${n} replies`);
      this.buf = this.buf.slice(pos) + this.dec.decode(value, { stream: true });
      pos = 0;
    }
    this.buf = this.buf.slice(pos);
    return out;
  }
  close() { this.w.close().catch(() => {}); }
}

async function open(env, q, stallMs) {
  const name = q.get("db");
  if (q.get("via") === "shard") {
    const db = await database(env, name);
    return new Resp(shardStub(env, db, Number(q.get("shard") ?? 0)).connect("valkey:6379"), stallMs);
  }
  const c = new Resp(env.SELF.connect(`${name}:6379`), stallMs);
  if (env.VALKEY_PASSWORD) {
    const [r] = await c.call(["AUTH", env.VALKEY_PASSWORD]);
    if (r?.err) throw new Error(`AUTH: ${r.err}`);
  }
  return c;
}

const info = async (c, section) =>
  Object.fromEntries(String((await c.call(["INFO", section]))[0]).split("\r\n").filter((l) => l.includes(":")).map((l) => l.split(":")));
const pct = (xs, p) => xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const allShards = async (env, name, fn) => { const db = await database(env, name); return Promise.all(Array.from({ length: db.shards }, (_, i) => fn(shardStub(env, db, i), i))); };

const tests = {
  // regions=world spreads a new database's shards over WORLD; regions=a,b,c over those hints.
  // replicas=world (or a,b,c) keeps a read replica of every shard in each of those regions.
  async db(env, q) {
    const list = (v) => (v === "world" ? WORLD : v ? v.split(",") : undefined);
    const db = await database(env, q.get("db"), q.get("shards") ? Number(q.get("shards")) : undefined, list(q.get("regions")), list(q.get("replicas")), q.get("classes") ? Number(q.get("classes")) : undefined);
    if (db.replicas) await configureReplicas(env, db);
    return { db };
  },

  // How long shard 0's storage takes to confirm a write, from inside the object.
  async commit(env, q) {
    const db = await database(env, q.get("db"));
    const stub = shardStub(env, db, 0);
    await stub.stats(); // learn its colo
    const r = await stub.commitProbe(Number(q.get("n") ?? 20));
    return { colo: r.colo, p50: r.ms[r.ms.length >> 1], min: r.ms[0], max: r.ms.at(-1) };
  },

  // Fragmentation: n keys with seeded random value sizes in [min, max], then `rounds` times delete a random
  // half and rewrite it with sizes in [min2, max2] (default [min, max]). After each round: Valkey's used_memory
  // vs the wasm linear memory it grew (which never shrinks, and is what counts against the isolate's memory).
  // type=hash keeps the values as fields of small hashes (100 per key), which grow and shrink by realloc.
  // Run with via=shard.
  // AOF rewrite cost on shard 0: BGREWRITEAOF while another client PINGs it in a loop. replyMs is when
  // the command answered; totalMs is when no rewrite is in progress any more.
  async rewrite(env, q) {
    const db = await database(env, q.get("db")), stub = shardStub(env, db, 0), c = await open(env, q);
    const lat = [], slow = []; // slow: [ms after BGREWRITEAOF was sent, ping ms] for pings over 150 ms
    let stop = false, t0 = 0;
    const pinger = (async () => { while (!stop) { const t = Date.now(); await c.call(["PING"]); const ms = Date.now() - t; lat.push(ms); if (ms > 150) slow.push([t - t0, ms]); } })();
    await new Promise((r) => setTimeout(r, 500));
    t0 = Date.now();
    const [reply] = await stub.run([["BGREWRITEAOF"]]), replyMs = Date.now() - t0;
    while ((await stub.run([["INFO", "persistence"]]))[0].includes("aof_rewrite_in_progress:1")) await new Promise((r) => setTimeout(r, 50));
    const totalMs = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 500));
    stop = true;
    await pinger;
    c.close();
    lat.sort((a, b) => a - b);
    const st = await stub.stats(), base = st.files.find((f) => /\.base\./.test(f.path));
    return { reply, replyMs, totalMs, pings: lat.length, p50: lat[lat.length >> 1], p99: lat[Math.floor(lat.length * 0.99)], max: lat.at(-1), slow, base: base && { path: base.path, MB: +(base.size / 2 ** 20).toFixed(1) }, helper: st.lastRewrite && { ...st.lastRewrite, at: st.lastRewrite.at - t0 } };
  },

  async frag(env, q) {
    const n = Number(q.get("n") ?? 150000), min = Number(q.get("min") ?? 16), max = Number(q.get("max") ?? 512), rounds = Number(q.get("rounds") ?? 6);
    let seed = Number(q.get("seed") ?? 1) >>> 0;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const min2 = Number(q.get("min2") ?? min), max2 = Number(q.get("max2") ?? max), hash = q.get("type") === "hash";
    // rand=1: incompressible values (RDB compresses repeated bytes to almost nothing).
    const pool = q.get("rand") === "1" ? btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(3 << 10)))) : null;
    const val = (lo = min, hi = max) => { const len = lo + Math.floor(rnd() * (hi - lo + 1)); if (!pool) return "x".repeat(len); const at = Math.floor(rnd() * (pool.length - len)); return pool.slice(at, at + len); };
    const set = (i, v) => (hash ? ["HSET", `f:${Math.floor(i / 100)}`, i, v] : ["SET", `f:${i}`, v]);
    const del = (i) => (hash ? ["HDEL", `f:${Math.floor(i / 100)}`, i] : ["DEL", `f:${i}`]);
    const db = await database(env, q.get("db")), stub = shardStub(env, db, 0), c = await open(env, q);
    const mem = async (round) => {
      const [info] = await c.call(["INFO", "memory"]);
      const f = (k) => Number(new RegExp(`${k}:(\\d+)`).exec(info)?.[1] ?? NaN);
      const wasm = (await stub.stats()).wasmMemoryBytes, used = f("used_memory");
      return { round, usedMB: +(used / 2 ** 20).toFixed(1), wasmMB: +(wasm / 2 ** 20).toFixed(1), wasmPerUsed: +(wasm / used).toFixed(2), allocator: /mem_allocator:(\S+)/.exec(info)?.[1] };
    };
    const batch = async (cmds) => { for (let i = 0; i < cmds.length; i += 1000) { const rs = await c.call(...cmds.slice(i, i + 1000)); const e = rs.find((r) => r?.err); if (e) throw new Error(e.err); } };
    const out = [];
    await c.call(["FLUSHALL"]);
    out.push(await mem("empty"));
    await batch(Array.from({ length: n }, (_, i) => set(i, val())));
    out.push(await mem("filled"));
    for (let r = 1; r <= rounds; r++) {
      const pick = Array.from({ length: n }, (_, i) => i).filter(() => rnd() < 0.5);
      await batch(pick.map(del));
      await batch(pick.map((i) => set(i, val(min2, max2))));
      out.push(await mem(r));
    }
    c.close();
    return { n, min, max, min2, max2, type: hash ? "hash" : "string", rounds, memory: out };
  },

  // One execRaw (the router's RPC mode) of k SETs straight to shard 0: are all k replies there?
  async rpcbatch(env, q) {
    const db = await database(env, q.get("db")), k = Number(q.get("k") ?? 1000), par = Number(q.get("par") ?? 1);
    const body = new TextEncoder().encode(Array.from({ length: k }, (_, i) => cmd("SET", `rb:${i}`, "v")).join(""));
    const stub = shardStub(env, db, 0), t0 = Date.now();
    const rs = await Promise.allSettled(Array.from({ length: par }, () => stub.execRaw(body, k, 2)));
    const frames = (r) => { let n = 0; for (let i = 0; i < r.length; i += 5) n += r[i] === 43 ? 1 : 0; return n; }; // "+OK\r\n"
    return { k, par, bodyBytes: body.length, ms: Date.now() - t0, results: rs.map((r) => (r.status === "fulfilled" ? { bytes: r.value.length, frames: frames(r.value) } : { error: String(r.reason?.message ?? r.reason) })) };
  },

  // A/B on one primary: point its shards' replication at `regions` (none | world | a,b), leaving reads alone.
  async replicate(env, q) {
    const db = await database(env, q.get("db")), v = q.get("regions");
    const regions = v === "none" ? [] : v === "world" ? WORLD : v.split(",");
    await Promise.all(Array.from({ length: db.shards }, (_, i) => shardStub(env, db, i).replicate(regions)));
    return { regions };
  },

  // Run a test (default throughput) from a Sender object in `region`, so its traffic enters Cloudflare there.
  async send(env, q) {
    const region = q.get("region");
    if (!HINTS.has(region)) throw new Error(`region must be one of ${[...HINTS].join(", ")}`);
    const params = Object.fromEntries(q);
    delete params.region; delete params.sender;
    // sender=<k> picks one of several Sender objects in the region, so load can come from many isolates.
    const name = q.get("sender") ? `${region}/${q.get("sender")}` : region;
    return { region, ...(await env.SENDER.getByName(name, { locationHint: region }).run(params)) };
  },

  // Chaos hook: hard-reset one shard (shard=<i>) or all of them, as a crash or deploy would.
  async abort(env, q) {
    const db = await database(env, q.get("db"));
    const which = q.get("shard") ?? "all";
    const idx = which === "all" ? Array.from({ length: db.shards }, (_, i) => i) : [Number(which)];
    const replica = q.get("replica"); // a region: abort that region's replica of each shard instead
    await Promise.all(idx.map((i) => (replica ? replicaStub(env, db, i, replica) : shardStub(env, db, i)).abort().catch(() => {})));
    return { aborted: idx, ...(replica ? { replica } : {}) };
  },

  // Every shard's stats with Valkey's own INFO counters, for the live view in ui/. A shard that can't
  // answer right now is { down }, so the others still show.
  async shards(env, q) {
    const db = await database(env, q.get("db"));
    const one = (stub) => stub.snapshot().catch((e) => ({ down: e.message }));
    const shards = await Promise.all(Array.from({ length: db.shards }, async (_, i) => {
      const regions = db.replicas ?? [];
      const [primary, ...copies] = await Promise.all([one(shardStub(env, db, i)), ...regions.map((r) => one(replicaStub(env, db, i, r)))]);
      return { ...primary, replicaSnapshots: copies.map((c, k) => ({ region: regions[k], ...c })) };
    }));
    return { db, shards };
  },

  // What every isolate running routers last reported (src/pulse.js), for ui/.
  async pulse(env) {
    return env.PULSE ? await env.PULSE.getByName("pulse").snapshot() : { isolates: [], disabled: "no PULSE binding" };
  },

  async dbs(env) {
    return { dbs: await env.CATALOG.getByName("catalog").list() };
  },

  // Read-your-writes on one connection: SET then GET the same key, n times. Every GET must see its SET.
  async ryw(env, q) {
    const n = Number(q.get("n") ?? 200), tag = q.get("prefix") ?? "ryw", c = await open(env, q);
    // A SET that failed (LOST: may or may not have run) owes nothing to the next read, so it's counted apart.
    let stale = 0, failedWrites = 0;
    const samples = [];
    for (let i = 0; i < n; i++) {
      const k = `${tag}:${i % 20}`, v = `${tag}-${i}`, t0 = Date.now();
      const [set] = await c.call(["SET", k, v]);
      const t1 = Date.now(), [got] = await c.call(["GET", k]);
      if (set !== "OK") failedWrites++;
      else if (got !== v) { stale++; if (samples.length < 5) samples.push({ i, k, want: v, got, setMs: t1 - t0, getMs: Date.now() - t1 }); }
    }
    c.close();
    return { n, stale, failedWrites, samples };
  },

  // How long after an acknowledged write another client, on its own connection, can still read the old
  // value: the replica lag a user sees. 0 when reads come from the primary.
  async staleness(env, q) {
    const n = Number(q.get("n") ?? 200), tag = q.get("prefix") ?? "stale", a = await open(env, q), b = await open(env, q);
    const xs = [];
    let failedWrites = 0, gaveUp = 0, firstRead = 0;
    for (let i = 0; i < n; i++) {
      const k = `${tag}:${i % 20}`, v = `${tag}-${i}-${Date.now()}`;
      const [set] = await a.call(["SET", k, v]);
      const acked = performance.now();
      if (set !== "OK") { failedWrites++; continue; }
      for (let tries = 1; ; tries++) {
        const [got] = await b.call(["GET", k]);
        if (got === v) { xs.push(performance.now() - acked); if (tries === 1) firstRead++; break; }
        if (performance.now() - acked > 10000) { gaveUp++; break; }
      }
    }
    a.close(); b.close();
    const ms = (p) => Math.round(pct(xs, p) ?? NaN);
    return { n, p50: ms(0.5), p90: ms(0.9), p99: ms(0.99), max: Math.round(Math.max(...xs)), firstRead, failedWrites, gaveUp };
  },

  async stats(env, q) {
    const s = await allShards(env, q.get("db"), (stub) => stub.stats());
    return { shards: s.map(({ files, ...rest }) => ({ ...rest, files: files.map((f) => `${f.path}:${f.size}/${f.rows}`) })) };
  },

  async latency(env, q) {
    const n = Number(q.get("n") ?? 200), c = await open(env, q);
    const t0 = performance.now();
    await c.call(["PING"]);
    const first = performance.now() - t0, xs = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      await c.call(["GET", `lat:${i}`]);
      xs.push(performance.now() - t);
    }
    c.close();
    return { firstMs: first, n, p50: pct(xs, 0.5), p99: pct(xs, 0.99), max: Math.max(...xs) };
  },

  // Pipelined SETs across `conns` connections, keys spread over every slot; checks every reply.
  async throughput(env, q) {
    const n = Number(q.get("n") ?? 100000), batch = Number(q.get("batch") ?? 1000), conns = Number(q.get("conns") ?? 1);
    const size = Number(q.get("value") ?? 1), v = "v".repeat(size), get = q.get("op") === "get"; // op=get reads the same keys back
    const keys = Number(q.get("keys") ?? Infinity), key = (ci, j) => `${q.get("prefix") ?? "t"}${ci}:${j % keys}`; // keys=<m>: reuse m keys per conn
    const cs = await Promise.all(Array.from({ length: conns }, () => open(env, q)));
    await Promise.all(cs.map((c) => c.call(["PING"])));
    let errors = 0, firstError = null, hits = 0;
    const t0 = performance.now();
    await Promise.all(cs.map(async (c, ci) => {
      for (let i = 0; i < n / conns; i += batch) {
        const rs = await c.call(...Array.from({ length: batch }, (_, k) => (get ? ["GET", key(ci, i + k)] : ["SET", key(ci, i + k), v])));
        for (const r of rs) if (get ? r?.err : r !== "OK") { errors++; firstError ??= r; } else if (get && r === v) hits++;
      }
    }));
    const ms = performance.now() - t0;
    cs.forEach((c) => c.close());
    return { n, batch, conns, valueBytes: size, ms, opsPerSec: Math.round((n / ms) * 1000), errors, firstError, ...(get ? { hits } : {}) };
  },

  async conns(env, q) {
    const n = Number(q.get("n") ?? 10), par = Number(q.get("par") ?? 50), cs = [], errors = [];
    const t0 = Date.now();
    while (cs.length < n && !errors.length) {
      const batch = await Promise.allSettled(Array.from({ length: Math.min(par, n - cs.length) }, async () => {
        const c = await open(env, q);
        await c.call(["PING"]);
        return c;
      }));
      for (const r of batch) r.status === "fulfilled" ? cs.push(r.value) : errors.push(`at ${cs.length}: ${r.reason?.message}`);
    }
    cs.forEach((c) => c.close());
    return { requested: n, opened: cs.length, ms: Date.now() - t0, errors };
  },

  // Fill with `value`-byte strings until Valkey refuses (OOM) or a connection dies.
  async fill(env, q) {
    const c = await open(env, q), size = Number(q.get("value") ?? 65536), v = "x".repeat(size), limitKeys = Number(q.get("max") ?? 1e9);
    let keys = 0, stop = null;
    try {
      while (keys < limitKeys) {
        const r = await c.call(...Array.from({ length: 16 }, () => ["SET", `f${keys++}`, v]));
        const err = r.find((x) => x?.err);
        if (err) { stop = err.err; break; }
      }
    } catch (e) { stop = `connection: ${e.message}`; }
    c.close();
    const c2 = await open(env, q);
    const [dbsize] = await c2.call(["DBSIZE"]);
    c2.close();
    return { valueBytes: size, keysAttempted: keys, stoppedBy: stop, dbsize, approxMB: Math.round((dbsize * size) / 1048576) };
  },

  // Durability: write keys with known values, hard-reset every shard, then read everything back.
  async durability(env, q) {
    const n = Number(q.get("n") ?? 20000), batch = Number(q.get("batch") ?? 500), tag = q.get("tag") ?? String(Date.now());
    const c = await open(env, q);
    let acked = 0;
    for (let i = 0; i < n; i += batch) {
      const rs = await c.call(...Array.from({ length: Math.min(batch, n - i) }, (_, k) => ["SET", `d:${tag}:${i + k}`, `${tag}-${i + k}`]));
      for (const r of rs) if (r === "OK") acked++;
    }
    await c.call(["INCRBY", `d:${tag}:counter`, String(acked)]);
    c.close();
    const before = await allShards(env, q.get("db"), (s) => s.stats().then((x) => x.aliveSeconds));
    await allShards(env, q.get("db"), (s) => s.abort("durability test").catch(() => {}));
    const after = await allShards(env, q.get("db"), (s) => s.stats().then((x) => x.aliveSeconds));
    const c2 = await open(env, q);
    let missing = 0, wrong = 0;
    for (let i = 0; i < n; i += 1000) {
      const keys = Array.from({ length: Math.min(1000, n - i) }, (_, k) => `d:${tag}:${i + k}`);
      const [vals] = await c2.call(["MGET", ...keys]);
      vals.forEach((v, k) => { if (v === null) missing++; else if (v !== `${tag}-${i + k}`) wrong++; });
    }
    const [counter] = await c2.call(["GET", `d:${tag}:counter`]);
    c2.close();
    return { n, acked, missing, wrong, counter: Number(counter), restarted: after.every((a, i) => a < before[i]), aliveBefore: before, aliveAfter: after };
  },

  // write + verify, split so a deploy (or anything else) can happen in between.
  async write(env, q) {
    const n = Number(q.get("n") ?? 20000), tag = q.get("tag"), c = await open(env, q);
    let acked = 0;
    for (let i = 0; i < n; i += 500) {
      const rs = await c.call(...Array.from({ length: Math.min(500, n - i) }, (_, k) => ["SET", `w:${tag}:${i + k}`, `${tag}-${i + k}`]));
      acked += rs.filter((r) => r === "OK").length;
    }
    c.close();
    return { n, acked, alive: await allShards(env, q.get("db"), (s) => s.stats().then((x) => x.aliveSeconds)) };
  },
  async verify(env, q) {
    const n = Number(q.get("n") ?? 20000), tag = q.get("tag"), c = await open(env, q);
    let missing = 0, wrong = 0;
    for (let i = 0; i < n; i += 1000) {
      const [vals] = await c.call(["MGET", ...Array.from({ length: Math.min(1000, n - i) }, (_, k) => `w:${tag}:${i + k}`)]);
      vals.forEach((v, k) => { if (v === null) missing++; else if (v !== `${tag}-${i + k}`) wrong++; });
    }
    c.close();
    return { n, missing, wrong, alive: await allShards(env, q.get("db"), (s) => s.stats().then((x) => x.aliveSeconds)) };
  },

  async soak(env, q) {
    const seconds = Number(q.get("seconds") ?? 60), batch = Number(q.get("batch") ?? 500), c = await open(env, q);
    const t0 = Date.now();
    let ops = 0, error = null;
    try {
      while (Date.now() - t0 < seconds * 1000) {
        const rs = await c.call(...Array.from({ length: batch }, (_, k) => ["INCR", `soak{${k % 64}}`]));
        if (rs.some((r) => r?.err)) throw new Error(JSON.stringify(rs.find((r) => r?.err)));
        ops += batch;
      }
    } catch (e) { error = e.message; }
    c.close();
    const secs = (Date.now() - t0) / 1000;
    return { requestedSeconds: seconds, ranSeconds: secs, ops, opsPerSec: Math.round(ops / secs), error };
  },

  async cpu(env, q) {
    const c = await open(env, q, 60000), n = q.get("n") ?? "10000000";
    const t0 = Date.now();
    let result, error = null;
    try { [result] = await c.call(["EVAL", "local x=0 for i=1,tonumber(ARGV[1]) do x=x+i end return tostring(x)", "0", n]); } catch (e) { error = e.message; }
    c.close();
    return { iterations: n, ms: Date.now() - t0, result, error };
  },

  async cpuSoak(env, q) {
    const c = await open(env, q), n = q.get("n") ?? "3000000", seconds = Number(q.get("seconds") ?? 60);
    const t0 = Date.now();
    let calls = 0, error = null;
    try {
      while (Date.now() - t0 < seconds * 1000) {
        await c.call(["EVAL", "local x=0 for i=1,tonumber(ARGV[1]) do x=x+i end return 1", "0", n]);
        calls++;
      }
    } catch (e) { error = e.message; }
    c.close();
    return { iterationsPerCall: n, calls, ms: Date.now() - t0, error };
  },

  // POST { setup: [[...]], cmd: [...], seconds }: run setup once, then `cmd` in a loop on one connection.
  async repeat(env, q, req) {
    const { setup = [], cmd, seconds = 30 } = await req.json();
    const c = await open(env, q);
    for (let i = 0; i < setup.length; i += 100) await c.call(...setup.slice(i, i + 100));
    const t0 = Date.now(), retry = q.get("retry") === "1", errors = [];
    let calls = 0, error = null, last, slowest = 0;
    try {
      while (Date.now() - t0 < seconds * 1000) {
        const t = Date.now();
        [last] = await c.call(cmd);
        slowest = Math.max(slowest, Date.now() - t);
        calls++;
        if (last?.err) {
          if (!retry) throw new Error(last.err);
          errors.push({ atMs: Date.now() - t0, afterMs: Date.now() - t, err: last.err });
        }
      }
    } catch (e) { error = e.message; }
    c.close();
    return { calls, ms: Date.now() - t0, msPerCall: Math.round((Date.now() - t0) / Math.max(1, calls)), slowestMs: slowest, error, errors: errors.slice(0, 10), errorCount: errors.length, last: typeof last === "object" ? JSON.stringify(last).slice(0, 80) : last };
  },

  async idle(env, q) {
    const c = await open(env, q), seconds = Number(q.get("seconds") ?? 60);
    await c.call(["SET", "idle", "1"]);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    try { const [v] = await c.call(["GET", "idle"]); c.close(); return { idleSeconds: seconds, v }; } catch (e) { return { idleSeconds: seconds, error: e.message }; }
  },

  // K load generators as separate invocations (service-binding fetches to ourselves), so one
  // isolate's CPU doesn't cap the measurement. Each runs `test` with the remaining params.
  async loadgen(env, q, req) {
    const k = Number(q.get("workers") ?? 4), test = q.get("test") ?? "throughput";
    const params = new URLSearchParams(q);
    params.delete("workers");
    params.delete("test");
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: k }, async (_, i) => {
      params.set("prefix", `g${i}`);
      const res = await env.SELF.fetch(`https://self/${test}?${params}`, { headers: { authorization: req.headers.get("authorization") } });
      return res.json();
    }));
    const ms = Date.now() - t0;
    const total = results.reduce((n, r) => n + (r.n ?? 0), 0);
    return {
      workers: k, wallMs: ms,
      opsPerSec: Math.round((total / ms) * 1000),
      sumOfWorkerOpsPerSec: results.reduce((n, r) => n + (r.opsPerSec ?? 0), 0),
      errors: results.reduce((n, r) => n + (r.errors ?? 0), 0),
      firstError: results.find((r) => r.firstError || r.error)?.firstError ?? results.find((r) => r.error)?.error ?? null,
      colos: [...new Set(results.map((r) => r.colo))],
    };
  },

  // Stock ioredis inside this Worker through the TCP binding (src/client.js).
  async ioredis(env, q) {
    const db = q.get("db"), k = `io:${Date.now()}`;
    const opts = { Connector: bindingConnector(env.SELF, db), maxRetriesPerRequest: 1, password: env.VALKEY_PASSWORD || undefined };
    const a = new Redis(opts), b = new Redis(opts), sub = new Redis(opts);
    const out = {};
    try {
      out.ping = await a.ping();
      out.set = await a.set(`${k}:s`, "v", "PX", 60000);
      out.get = await b.get(`${k}:s`);
      out.mget = await a.mget(`${k}:s`, `${k}:missing`, `{${k}}x`);
      out.multi = await a.multi().incr(`{${k}}n`).incr(`{${k}}n`).exec();
      out.eval = await a.eval("return redis.call('INCRBY', KEYS[1], ARGV[1])", 1, `{${k}}n`, 40);
      const popped = b.blpop(`${k}:q`, 5);
      await a.lpush(`${k}:q`, "job");
      out.blpop = await popped;
      const got = new Promise((r) => sub.on("message", (_c, m) => r(m)));
      await sub.subscribe(`${k}:ch`);
      await a.publish(`${k}:ch`, "hi");
      out.pubsub = await got;
      const p = a.pipeline();
      for (let i = 0; i < 1000; i++) p.set(`${k}:p${i}`, i);
      const t0 = Date.now();
      out.pipeline = (await p.exec()).filter(([e, r]) => !e && r === "OK").length;
      out.pipelineMs = Date.now() - t0;
    } catch (e) { out.error = e.message; }
    a.disconnect(); b.disconnect(); sub.disconnect();
    return out;
  },

  async run(env, q, req) {
    // Run arbitrary commands: POST [["SET","k","v"],["GET","k"]]
    const c = await open(env, q);
    const cmds = await req.json();
    const out = await c.call(...cmds);
    c.close();
    return { replies: out };
  },
};

export const runTest = (name, env, q) => { if (!tests[name]) throw new Error(`no test named ${name}`); return tests[name](env, q); };

export async function bench(req, env) {
  const url = new URL(req.url);
  // Unset BENCH_TOKEN means no bench API, not a token of "undefined".
  if (!env.BENCH_TOKEN || !sameSecret(req.headers.get("authorization") ?? "", `Bearer ${env.BENCH_TOKEN}`)) return new Response("unauthorized", { status: 401 });
  const name = url.pathname.slice(1);
  const test = tests[name];
  if (!test) return new Response(`tests: ${Object.keys(tests).join(", ")}`, { status: 404 });
  url.searchParams.set("via", url.searchParams.get("via") ?? "router");
  url.searchParams.set("db", url.searchParams.get("db") ?? "default");
  try {
    return Response.json({ test: name, via: url.searchParams.get("via"), db: url.searchParams.get("db"), colo: req.cf?.colo, ...(await test(env, url.searchParams, req)) });
  } catch (e) {
    return Response.json({ test: name, error: e.message, stack: e.stack }, { status: 500 });
  }
}
