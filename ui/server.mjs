// Live view of one vado database. Polls the bench API for every shard's stats, probes latency over TCP,
// runs load and crashes shards on request, and streams one snapshot per poll to the page over SSE.
// The bench token and password stay in this process; it listens on 127.0.0.1 only.
//
//   node ui/server.mjs                       # local workerd (scripts/local.sh)
//   VADO_URL=https://<worker>.workers.dev TOKEN=... HOST=<tcp host> PORT=6379 PW=... node ui/server.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fork } from "node:child_process";
import Redis from "ioredis";
import { shardOfSlot, slotOf } from "../src/slots.js";

const env = process.env;
const BASE = env.VADO_URL ?? "http://127.0.0.1:8787";
const TOKEN = env.TOKEN ?? "local";
const HOST = env.HOST ?? "127.0.0.1", PORT = Number(env.PORT ?? 6380), PW = env.PW ?? "any";
const UI_PORT = Number(env.UI_PORT ?? 4040), POLL_MS = Number(env.POLL_MS ?? 1000);
const HISTORY = 60; // per-shard ops/s points kept, one per poll
const PROBE_MS = 250, PROBE_KEEP = 240; // one probe command every 250 ms; the last minute is kept
const CHAOS_MS = 10_000;
const WRITES = new Set(("set setex psetex setnx mset msetnx getset getdel getex append incr incrby incrbyfloat decr decrby del unlink " +
  "expire pexpire expireat pexpireat persist rename renamenx lpush rpush lpushx rpushx lpop rpop lset lrem ltrim linsert lmove blmove " +
  "rpoplpush blpop brpop sadd srem spop smove sinterstore sunionstore sdiffstore hset hsetnx hmset hdel hincrby hincrbyfloat zadd " +
  "zincrby zrem zpopmin zpopmax zremrangebyscore zremrangebyrank zremrangebylex xadd xdel xtrim xack setrange setbit pfadd pfmerge " +
  "flushall flushdb restore copy eval evalsha fcall").split(" "));

const api = async (path) => {
  const r = await fetch(`${BASE}/${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = await r.json().catch(() => null);
  if (r.status === 404 && path.startsWith("shards")) throw new Error("This Worker has no live-view endpoints yet. Deploy this branch's src/bench.js with wrangler deploy.");
  if (r.status === 401) throw new Error("The bench API refused the token. Set TOKEN to the Worker's BENCH_TOKEN.");
  if (!r.ok || body === null || body.error) throw new Error(body?.error ?? `bench API answered ${r.status}`);
  return body;
};

// ---- per-database state ----
let db = env.DB ?? "default";
let view = fresh();
function fresh() { return { meta: null, prev: [], history: [], restartedAt: [], crashAt: new Map(), shards: [], mix: [] }; }
const events = [];
const event = (kind, text) => { events.unshift({ t: Date.now(), kind, text }); events.length = Math.min(events.length, 60); };
const keep = (a, n) => { while (a.length > n) a.shift(); };
const shardOf = (key) => (view.meta ? shardOfSlot(slotOf(Buffer.from(key)), view.meta.shards) : 0);

// ---- polling ----
let polling = false, lastError = null, lastPoll = 0;
async function poll() {
  if (polling) return;
  polling = true;
  const name = db, v = view;
  try {
    const { db: meta, shards } = await api(`shards?db=${encodeURIComponent(name)}`);
    if (name !== db) return; // switched databases mid-poll
    const at = Date.now(), mix = {};
    v.meta = meta;
    v.shards = shards.map((s, i) => {
      const p = v.prev[i], h = (v.history[i] ??= []);
      if (s.down) {
        if (p && !p.down) event("down", `Shard ${i} stopped answering: ${s.down}`);
        v.prev[i] = { down: true, instance: p?.instance };
        h.push(0); keep(h, HISTORY);
        return { i, down: s.down, history: h };
      }
      const info = s.info;
      const stats = {};
      for (const [k, val] of Object.entries(info)) if (k.startsWith("cmdstat_")) stats[k.slice(8)] = Number(/calls=(\d+)/.exec(val)?.[1] ?? 0);
      const same = p && !p.down && p.instance === s.instance;
      if (p?.instance && p.instance !== s.instance) {
        const crashed = v.crashAt.get(i);
        event("restart", `Shard ${i} restarted${crashed ? `, answering again ${((at - crashed) / 1000).toFixed(1)} s after the crash` : ""}`);
        v.crashAt.delete(i);
        v.restartedAt[i] = at;
      }
      // Count per-command deltas, leaving out this poll's own INFO.
      let writes = 0, total = 0;
      if (same) for (const [c, n] of Object.entries(stats)) {
        const d = n - (p.stats[c] ?? 0);
        if (d <= 0 || c === "info") continue;
        mix[c] = (mix[c] ?? 0) + d; total += d;
        if (WRITES.has(c.split("|")[0])) writes += d;
      }
      const ops = same ? total / ((at - p.at) / 1000) : 0;
      v.prev[i] = { at, instance: s.instance, stats };
      h.push(ops); keep(h, HISTORY);
      const ks = /keys=(\d+),expires=(\d+)/.exec(info.db0 ?? "");
      return {
        i, ops, writeShare: total ? writes / total : 0, history: h,
        keys: ks ? Number(ks[1]) : 0, expires: ks ? Number(ks[2]) : 0,
        mem: Number(info.used_memory), memPeak: Number(info.used_memory_peak), maxmem: Number(info.maxmemory),
        sockets: s.sockets, pooled: s.pooled, aof: Number(info.aof_current_size), rows: s.vfs.rowsWritten, wasm: s.wasmMemoryBytes,
        uptime: s.aliveSeconds, instance: s.instance, restartedAt: v.restartedAt[i] ?? 0,
        hits: Number(info.keyspace_hits), misses: Number(info.keyspace_misses), evicted: Number(info.evicted_keys), expired: Number(info.expired_keys),
      };
    });
    const total = Object.values(mix).reduce((a, b) => a + b, 0);
    v.mix = Object.entries(mix).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => ({ cmd: c, share: n / total, write: WRITES.has(c.split("|")[0]) }));
    lastError = null; lastPoll = at;
  } catch (e) {
    if (name === db) lastError = e.message;
  } finally {
    polling = false;
    broadcast();
  }
}
setInterval(poll, POLL_MS);

// ---- latency probe: one connection, PING / GET / SET in turn, keys spread over every shard ----
let probe = null, probeBusy = false, probeN = 0;
const samples = [];
function connectProbe() {
  probe?.disconnect();
  probe = new Redis({ host: HOST, port: PORT, username: db, password: PW, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => 500 });
  probe.on("error", () => {});
}
setInterval(async () => {
  const c = probe;
  if (probeBusy || c?.status !== "ready") return;
  probeBusy = true;
  const n = probeN++, cmd = ["PING", "GET", "SET"][n % 3], key = `probe:${Math.floor(n / 3) % 97}`;
  const shard = cmd === "PING" ? null : shardOf(key), t0 = performance.now();
  try {
    if (cmd === "PING") await c.ping(); else if (cmd === "GET") await c.get(key); else await c.set(key, String(n));
    samples.push({ t: Date.now(), cmd, ms: performance.now() - t0, shard });
  } catch (e) {
    samples.push({ t: Date.now(), cmd, ms: performance.now() - t0, shard, err: e.message.slice(0, 90) });
    event("lost", `Probe ${cmd}${shard === null ? "" : ` on shard ${shard}`} failed: ${e.message.slice(0, 90)}`);
  }
  keep(samples, PROBE_KEEP);
  probeBusy = false;
}, PROBE_MS);

// ---- load, in a child process ----
let load = null;
function startLoad(conns, depth, mix) {
  stopLoad(false);
  const child = fork(new URL("./load.mjs", import.meta.url), [HOST, PORT, db, PW, conns, depth, mix, 100_000].map(String));
  const l = { child, conns, depth, mix, ops: 0, errors: 0, lastError: null, since: Date.now() };
  child.on("message", (m) => Object.assign(l, m));
  child.on("exit", () => { if (load === l) load = null; });
  load = l;
  event("load", `Started load: ${conns} connections, ${depth}-deep pipelines, ${mix}`);
}
function stopLoad(log = true) {
  if (!load) return;
  const { child } = load;
  child.send("stop");
  setTimeout(() => child.kill(), 3000).unref();
  load = null;
  if (log) event("load", "Stopped load");
}

// ---- crashes ----
let chaos = null;
async function crash(i) {
  view.crashAt.set(i, Date.now());
  await api(`abort?db=${encodeURIComponent(db)}&shard=${i}`);
  event("crash", `Crashed shard ${i}`);
}
function setChaos(on) {
  clearInterval(chaos);
  chaos = on ? setInterval(() => view.meta && crash(Math.floor(Math.random() * view.meta.shards)).catch((e) => event("lost", `Crash failed: ${e.message}`)), CHAOS_MS) : null;
  event("crash", on ? `Crashing a random shard every ${CHAOS_MS / 1000} s` : "Stopped crashing shards");
}

// ---- console: one command at a time on its own connection ----
let cli = null;
const NO_CONSOLE = new Set(["subscribe", "psubscribe", "ssubscribe", "monitor", "quit", "reset"]);
async function runCommand(line) {
  const argv = [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  if (!argv.length) throw new Error("Type a command, such as GET mykey");
  if (NO_CONSOLE.has(argv[0].toLowerCase())) throw new Error(`${argv[0].toUpperCase()} changes the connection's mode; run it from valkey-cli instead`);
  if (!cli) { cli = new Redis({ host: HOST, port: PORT, username: db, password: PW, maxRetriesPerRequest: 0 }); cli.on("error", () => {}); }
  return await cli.call(argv[0], ...argv.slice(1));
}

async function switchDb(name, shards) {
  await api(`db?db=${encodeURIComponent(name)}${shards ? `&shards=${shards}` : ""}`);
  stopLoad(false); if (chaos) setChaos(false);
  db = name; view = fresh(); samples.length = 0;
  cli?.disconnect(); cli = null;
  connectProbe();
  event("info", `Watching database ${name}`);
  poll();
}

// ---- snapshots to the page ----
const clients = new Set();
const snapshot = () => JSON.stringify({
  at: lastPoll, now: Date.now(), error: lastError, target: { api: new URL(BASE).host, tcp: `${HOST}:${PORT}` },
  db: view.meta ?? { name: db }, shards: view.shards, mix: view.mix,
  probe: { status: probe?.status ?? "off", samples },
  load: load && { conns: load.conns, depth: load.depth, mix: load.mix, ops: load.ops, errors: load.errors, lastError: load.lastError, since: load.since },
  chaos: !!chaos, events: events.slice(0, 40),
});
function broadcast() { const msg = `data: ${snapshot()}\n\n`; for (const res of clients) res.write(msg); }

const body = (req) => new Promise((res, rej) => { let s = ""; req.on("data", (d) => { s += d; if (s.length > 1e5) rej(new Error("request too large")); }); req.on("end", () => { try { res(s ? JSON.parse(s) : {}); } catch { rej(new Error("expected JSON")); } }); });
const int = (v, lo, hi) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`expected an integer from ${lo} to ${hi}`); return n; };
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

const routes = {
  "GET /": async (req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(await readFile(new URL("./index.html", import.meta.url))); },
  "GET /slots.js": async (req, res) => { res.writeHead(200, { "content-type": "text/javascript" }); res.end(await readFile(new URL("../src/slots.js", import.meta.url))); },
  "GET /events": (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${snapshot()}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  },
  "GET /dbs": async (req, res) => json(res, 200, await api("dbs")),
  "POST /db": async (req, res) => {
    const { name, shards } = await body(req);
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw new Error("Database names are 1-63 characters of a-z 0-9 _ -, starting with a letter or digit");
    await switchDb(name, shards ? int(shards, 1, 256) : undefined);
    json(res, 200, { ok: true });
  },
  "POST /load": async (req, res) => {
    const { conns, depth, mix } = await body(req);
    if (!["reads", "writes", "both"].includes(mix)) throw new Error("mix is reads, writes or both");
    startLoad(int(conns, 1, 512), int(depth, 1, 512), mix);
    json(res, 200, { ok: true });
  },
  "POST /stop": async (req, res) => { stopLoad(); json(res, 200, { ok: true }); },
  "POST /crash": async (req, res) => { const { shard } = await body(req); await crash(int(shard, 0, (view.meta?.shards ?? 1) - 1)); json(res, 200, { ok: true }); },
  "POST /chaos": async (req, res) => { const { on } = await body(req); setChaos(!!on); json(res, 200, { ok: true }); },
  "POST /cmd": async (req, res) => {
    const { line } = await body(req);
    try { json(res, 200, { reply: await runCommand(String(line ?? "")) }); } catch (e) { json(res, 200, { error: e.message }); }
  },
};

http.createServer(async (req, res) => {
  const route = routes[`${req.method} ${new URL(req.url, "http://x").pathname}`];
  if (!route) return json(res, 404, { error: "not found" });
  try { await route(req, res); } catch (e) { json(res, 400, { error: e.message }); }
}).listen(UI_PORT, "127.0.0.1", () => {
  console.log(`vado live: http://127.0.0.1:${UI_PORT}  (bench API ${BASE}, TCP ${HOST}:${PORT}, database ${db})`);
  connectProbe();
  poll();
});
