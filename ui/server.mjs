// Live view of one vado database in production. Polls the Worker's bench API for each shard's
// numbers and where traffic enters Cloudflare, measures response time from this computer over TCP,
// runs test traffic and shard restarts on request, and streams one snapshot a second to the page.
// The bench token and password stay in this process; it listens on 127.0.0.1 only.
//
//   VADO_URL=https://<worker>.workers.dev TOKEN=... HOST=<tcp host> PORT=6379 PW=... DB=<name> node ui/server.mjs
import http from "node:http";
import { readFile } from "node:fs/promises";
import Redis from "ioredis";
import { shardOfSlot, slotOf } from "../src/slots.js";

const env = process.env;
const BASE = env.VADO_URL, TOKEN = env.TOKEN, HOST = env.HOST, PORT = Number(env.PORT ?? 6379), PW = env.PW;
if (!BASE || !TOKEN || !HOST || !PW) throw new Error("Set VADO_URL, TOKEN, HOST and PW (see the comment at the top of ui/server.mjs)");
const UI_PORT = Number(env.UI_PORT ?? 4040);
const POLL_MS = 1000, HISTORY = 300, PROBE_MS = 300, RESTARTING_MS = 10_000;
const LEVELS = { light: 1, medium: 3, heavy: 6 }; // test senders running at once, per region
// Where test traffic can come from (Durable Object location hints), and where shards can be placed.
const REGIONS = { wnam: "Western North America", enam: "Eastern North America", sam: "South America", weur: "Western Europe", eeur: "Eastern Europe", me: "Middle East", afr: "Africa", apac: "Asia Pacific", oc: "Oceania" };
const WRITES = new Set(("set setex psetex setnx mset msetnx getset getdel getex append incr incrby incrbyfloat decr decrby del unlink " +
  "expire pexpire expireat pexpireat persist rename renamenx lpush rpush lpushx rpushx lpop rpop lset lrem ltrim linsert lmove " +
  "rpoplpush blpop brpop sadd srem spop smove hset hsetnx hmset hdel hincrby hincrbyfloat zadd zincrby zrem zpopmin zpopmax " +
  "xadd xdel xtrim xack setrange setbit pfadd flushall flushdb restore copy eval evalsha fcall").split(" "));

const api = async (path) => {
  const r = await fetch(`${BASE}/${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = await r.json().catch(() => null);
  if (r.status === 401) throw new Error("The Worker refused the token (TOKEN must match its BENCH_TOKEN)");
  if (!r.ok || body === null || body.error) throw new Error(body?.error ?? `The Worker answered ${r.status}`);
  return body;
};

// ---- places: Cloudflare locations (for city names and coordinates) ----
const SPEED = { headers: { referer: "https://speed.cloudflare.com/", origin: "https://speed.cloudflare.com", "user-agent": "Mozilla/5.0" } };
const places = {};
fetch("https://speed.cloudflare.com/locations", SPEED).then((r) => r.json())
  .then((list) => { for (const c of list) places[c.iata] = { city: c.city, lat: c.lat, lon: c.lon }; }).catch(() => {});

// ---- state ----
let db = env.DB ?? "default";
let view = fresh();
function fresh() { return { meta: null, shards: [], prev: [], restartedAt: [], askedAt: new Map(), history: [], isoPrev: new Map(), map: null, copyPrev: new Map() }; }
// Commands a replica runs that aren't reads: the replicated writes, and the stream's own bookkeeping.
const NOT_READS = new Set(["info", "ping", "client", "select", "multi", "exec", "flushall", "command"]);
const callsOf = (info) => { const c = {}; for (const [k, v] of Object.entries(info ?? {})) if (k.startsWith("cmdstat_")) c[k.slice(8)] = Number(/calls=(\d+)/.exec(v)?.[1] ?? 0); return c; };
const events = [];
const say = (kind, text) => { events.unshift({ t: Date.now(), kind, text }); events.length = Math.min(events.length, 50); };
let lastError = null, lastPoll = 0, polling = false;

function traffic(pulse) {
  // Commands per second entering at each colo, from each isolate's running totals (src/index.js).
  const byColo = new Map(), seen = new Set();
  for (const iso of pulse.isolates) {
    seen.add(iso.isolate);
    const totals = { ...(iso.done ?? {}) };
    for (const c of iso.conns) totals[c.db] = (totals[c.db] ?? 0) + c.commands;
    const prev = view.isoPrev.get(iso.isolate);
    let ops = 0;
    if (prev && prev.at === iso.at) ops = prev.ops;
    else if (prev) ops = Math.max(0, ((totals[db] ?? 0) - (prev.totals[db] ?? 0)) / ((iso.at - prev.at) / 1000));
    view.isoPrev.set(iso.isolate, { at: iso.at, totals, ops });
    const conns = iso.conns.filter((c) => c.db === db).length;
    if (!conns && !ops) continue;
    const colo = iso.colo ?? "?", e = byColo.get(colo) ?? { colo, ops: 0, conns: 0 };
    e.ops += ops; e.conns += conns;
    byColo.set(colo, e);
  }
  for (const id of view.isoPrev.keys()) if (!seen.has(id)) view.isoPrev.delete(id);
  const homes = {};
  for (const s of view.shards) if (s.colo) homes[s.colo] = (homes[s.colo] ?? 0) + 1;
  const copies = {};
  for (const s of view.shards) for (const r of s.replicas ?? []) if (r.colo && r.state === "ready") { const c = (copies[r.colo] ??= { count: 0, reads: 0 }); c.count++; c.reads += r.reads; }
  const place = (colo) => places[colo] && { ...places[colo], colo };
  return {
    entries: [...byColo.values()].map((e) => ({ ...place(e.colo), ops: Math.round(e.ops), conns: e.conns })).filter((e) => e.city),
    shards: Object.entries(homes).map(([colo, count]) => ({ ...place(colo), count })).filter((h) => h.city),
    replicas: Object.entries(copies).map(([colo, c]) => ({ ...place(colo), count: c.count, reads: c.reads })).filter((h) => h.city),
  };
}

async function poll() {
  if (polling) return;
  polling = true;
  const name = db, v = view;
  try {
    const [{ db: meta, shards }, pulse] = await Promise.all([api(`shards?db=${encodeURIComponent(name)}`), api("pulse")]);
    if (name !== db) return;
    const at = Date.now();
    let reads = 0, writes = 0;
    v.meta = meta;
    v.shards = shards.map((s, i) => {
      const p = v.prev[i];
      if (s.down) {
        if (p && !p.down) say("warning", `Shard ${i} stopped responding`);
        v.prev[i] = { down: true, instance: p?.instance };
        return { i, ok: false };
      }
      const info = s.info, calls = {};
      for (const [k, val] of Object.entries(info)) if (k.startsWith("cmdstat_")) calls[k.slice(8)] = Number(/calls=(\d+)/.exec(val)?.[1] ?? 0);
      if (p?.instance && p.instance !== s.instance) {
        const asked = v.askedAt.get(i);
        say("warning", asked ? `Shard ${i} restarted and was back in ${((at - asked) / 1000).toFixed(1)} s` : `Shard ${i} restarted`);
        v.askedAt.delete(i);
        v.restartedAt[i] = at;
      }
      let r = 0, w = 0;
      if (p && !p.down && p.instance === s.instance) {
        const dt = (at - p.at) / 1000;
        for (const [c, n] of Object.entries(calls)) {
          const d = n - (p.calls[c] ?? 0);
          if (d <= 0 || c === "info") continue; // INFO is this page's own polling
          if (WRITES.has(c.split("|")[0])) w += d / dt; else r += d / dt;
        }
      }
      v.prev[i] = { at, instance: s.instance, calls };
      const ks = /keys=(\d+)/.exec(info.db0 ?? "");
      // Reads each replica served since the last poll (it also runs every write it's sent; those aren't counted).
      const snaps = new Map((s.replicaSnapshots ?? []).map((x) => [x.region, x]));
      const replicas = (s.replicas ?? []).map((x) => {
        const snap = snaps.get(x.region), key = `${i}/${x.region}`, prevCopy = v.copyPrev.get(key);
        let reads = 0;
        if (snap && !snap.down) {
          const c = callsOf(snap.info);
          if (prevCopy && prevCopy.instance === snap.instance) for (const [cmd, n] of Object.entries(c)) { const base = cmd.split("|")[0]; if (!WRITES.has(base) && !NOT_READS.has(base)) reads += (n - (prevCopy.calls[cmd] ?? 0)) / ((at - prevCopy.at) / 1000); }
          v.copyPrev.set(key, { at, instance: snap.instance, calls: c });
        }
        r += Math.max(0, reads);
        const colo = x.colo ?? snap?.colo ?? null;
        return { region: x.region, state: x.state, lagMs: x.lagMs, colo, city: places[colo]?.city ?? null, reads: Math.round(Math.max(0, reads)) };
      });
      reads += r; writes += w; // r now includes what this shard's replicas served
      return { i, ok: true, ops: Math.round(r + w), writeShare: r + w ? w / (r + w) : 0, keys: ks ? Number(ks[1]) : 0, mem: Number(info.used_memory), maxmem: Number(info.maxmemory), uptime: s.aliveSeconds, colo: s.colo, city: places[s.colo]?.city ?? null, restartedAt: v.restartedAt[i] ?? 0, replicas };
    });
    const since = at - POLL_MS * 1.5, recent = (cmd) => median(samples.filter((x) => x.t >= since && x.cmd === cmd && !x.err).map((x) => x.ms));
    v.history.push({ t: at, reads: Math.round(reads), writes: Math.round(writes), readMs: recent("GET"), writeMs: recent("SET") });
    if (v.history.length > HISTORY) v.history.shift();
    v.map = traffic(pulse);
    lastError = null; lastPoll = at;
  } catch (e) {
    if (name === db) lastError = e.message;
  } finally {
    polling = false;
    broadcast();
  }
}
const median = (xs) => (xs.length ? xs.sort((a, b) => a - b)[xs.length >> 1] : null);
setInterval(poll, POLL_MS);

// ---- response time, measured from this computer: one GET or SET at a time over TCP ----
let probe = null, probeBusy = false, probeN = 0;
const samples = [];
function connectProbe() {
  probe?.disconnect();
  probe = new Redis({ host: HOST, port: PORT, username: db, password: PW, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => 1000 });
  probe.on("error", () => {});
}
setInterval(async () => {
  if (probeBusy || probe?.status !== "ready") return;
  probeBusy = true;
  const n = probeN++, cmd = n % 2 ? "SET" : "GET", key = `vado-live:${Math.floor(n / 2) % 64}`, t0 = performance.now();
  try { if (cmd === "GET") await probe.get(key); else await probe.set(key, String(n)); samples.push({ t: Date.now(), cmd, ms: performance.now() - t0 }); }
  catch (e) { samples.push({ t: Date.now(), cmd, ms: performance.now() - t0, err: true }); }
  while (samples.length && samples[0].t < Date.now() - 60_000) samples.shift();
  probeBusy = false;
}, PROBE_MS);

// ---- test traffic: senders in Cloudflare regions, each writing 20,000 random keys over 4 connections ----
let test = null;
function startTest(level, from) {
  stopTest(false);
  const run = { level, from, since: Date.now(), stop: false };
  test = run;
  say("info", `Test traffic started: ${level}, from ${from === "everywhere" ? "everywhere" : REGIONS[from]}`);
  const regions = from === "everywhere" ? Object.keys(REGIONS) : [from];
  for (const region of regions) for (let i = 0; i < LEVELS[level]; i++) (async () => {
    // Overwrite the same 20,000 keys each round, then read them back three times, like a cache. The
    // keys stay the same so test traffic never fills the database.
    const send = (extra = "") => api(`send?db=${encodeURIComponent(db)}&region=${region}&sender=${i}&n=20000&batch=500&conns=4&prefix=test-${region}${i}-${extra}`);
    while (!run.stop) {
      try { await send(); for (let k = 0; k < 3 && !run.stop; k++) await send("&op=get"); }
      catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
  })();
}
function stopTest(log = true) { if (!test) return; test.stop = true; test = null; if (log) say("info", "Test traffic stopped"); }

// ---- commands from the page, on their own connection ----
let cli = null;
const NOT_HERE = new Set(["subscribe", "psubscribe", "ssubscribe", "monitor", "quit", "reset", "multi", "watch"]);
async function run(line) {
  const argv = [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  if (!argv.length) throw new Error("Type a command, for example GET greeting");
  if (NOT_HERE.has(argv[0].toLowerCase())) throw new Error(`${argv[0].toUpperCase()} needs a client that keeps its connection, such as valkey-cli`);
  if (!cli) { cli = new Redis({ host: HOST, port: PORT, username: db, password: PW, maxRetriesPerRequest: 0 }); cli.on("error", () => {}); }
  return await cli.call(argv[0], ...argv.slice(1));
}

async function watch(name) {
  await api(`db?db=${encodeURIComponent(name)}`);
  stopTest(false);
  db = name; view = fresh(); samples.length = 0;
  cli?.disconnect(); cli = null;
  connectProbe();
  poll();
}

// ---- snapshots ----
const clients = new Set();
function snapshot() {
  const shards = view.shards, now = Date.now();
  const ok = shards.filter((s) => s.ok);
  const restarting = shards.filter((s) => !s.ok || now - (s.restartedAt ?? 0) < RESTARTING_MS).length;
  const window = (cmd) => median(samples.filter((x) => x.cmd === cmd && !x.err).map((x) => x.ms));
  return JSON.stringify({
    at: lastPoll, now, error: lastError,
    db: { name: db, shards: view.meta?.shards ?? 0 },
    health: lastError ? "unreachable" : restarting ? "restarting" : shards.length ? "healthy" : "starting", restarting,
    totals: { ops: ok.reduce((a, s) => a + s.ops, 0), keys: ok.reduce((a, s) => a + s.keys, 0), mem: ok.reduce((a, s) => a + s.mem, 0), maxmem: ok.reduce((a, s) => a + s.maxmem, 0) },
    response: { read: window("GET"), write: window("SET"), failed: samples.filter((x) => x.err).length },
    history: view.history, shards: shards.map(({ colo, ...s }) => s), map: view.map,
    test: test && { level: test.level, from: test.from, since: test.since }, events: events.slice(0, 30),
  });
}
function broadcast() { const msg = `data: ${snapshot()}\n\n`; for (const res of clients) res.write(msg); }

const body = (req) => new Promise((res, rej) => { let s = ""; req.on("data", (d) => { s += d; if (s.length > 1e5) rej(new Error("request too large")); }); req.on("end", () => { try { res(s ? JSON.parse(s) : {}); } catch { rej(new Error("expected JSON")); } }); });
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };

const routes = {
  "GET /events": (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${snapshot()}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
  },
  "GET /api/databases": async (req, res) => json(res, 200, (await api("dbs")).dbs.filter((d) => !d.name.startsWith("__")).map((d) => ({ name: d.name, shards: d.shards, spread: !!d.regions && d.regions.length > 1, replicated: !!d.replicas }))),
  "GET /api/regions": (req, res) => json(res, 200, REGIONS),
  "POST /api/create": async (req, res) => {
    const { name, shards, place, replicas = false } = await body(req);
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw new Error("Use 1-63 lowercase letters, digits, - or _, starting with a letter or digit");
    if (![1, 4, 16, 64].includes(shards)) throw new Error("shards is 1, 4, 16 or 64");
    if (place !== "world" && !REGIONS[place]) throw new Error("place is world or a region");
    const { dbs } = await api("dbs");
    if (dbs.some((d) => d.name === name)) throw new Error(`${name} already exists; pick it from the list instead`);
    await api(`db?db=${encodeURIComponent(name)}&shards=${shards}&regions=${place}${replicas ? "&replicas=world" : ""}`);
    await watch(name);
    say("info", `Created ${name}: ${shards} shard${shards === 1 ? "" : "s"}, ${place === "world" ? "spread around the world" : `in ${REGIONS[place]}`}${replicas ? ", with read replicas in every region" : ""}`);
    json(res, 200, { ok: true });
  },
  "POST /api/watch": async (req, res) => {
    const { name } = await body(req);
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) throw new Error("Pick a database from the list");
    await watch(name); json(res, 200, { ok: true });
  },
  "POST /api/test": async (req, res) => {
    const { level, from = "everywhere" } = await body(req);
    if (level === null) stopTest();
    else if (LEVELS[level] && (from === "everywhere" || REGIONS[from])) startTest(level, from);
    else throw new Error("level is light, medium or heavy, and from is everywhere or a region");
    json(res, 200, { ok: true });
  },
  "POST /api/restart": async (req, res) => {
    const { shard } = await body(req), n = view.meta?.shards ?? 0;
    if (!Number.isInteger(shard) || shard < 0 || shard >= n) throw new Error(`shard is 0 to ${n - 1}`);
    view.askedAt.set(shard, Date.now());
    await api(`abort?db=${encodeURIComponent(db)}&shard=${shard}`);
    say("info", `Restarting shard ${shard}`);
    json(res, 200, { ok: true });
  },
  "POST /api/run": async (req, res) => {
    const { line } = await body(req);
    const argv = String(line ?? "").trim().split(/\s+/);
    const shard = argv[1] && view.meta ? shardOfSlot(slotOf(Buffer.from(argv[1])), view.meta.shards) : null;
    try { json(res, 200, { reply: await run(String(line ?? "")), shard }); } catch (e) { json(res, 200, { error: e.message }); }
  },
};

async function file(res, path) {
  const name = path === "/" ? "index.html" : path.slice(1);
  if (name.includes("..")) return json(res, 404, { error: "not found" });
  try {
    const data = await readFile(new URL(`./dist/${name}`, import.meta.url));
    res.writeHead(200, { "content-type": TYPES[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream" });
    res.end(data);
  } catch { json(res, 404, { error: path === "/" ? "Build the page first: npm --prefix ui run build" : "not found" }); }
}

http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://x").pathname, route = routes[`${req.method} ${path}`];
  try { if (route) await route(req, res); else if (req.method === "GET") await file(res, path); else json(res, 404, { error: "not found" }); }
  catch (e) { json(res, 400, { error: e.message }); }
}).listen(UI_PORT, "127.0.0.1", () => {
  console.log(`vado live: http://127.0.0.1:${UI_PORT}  (database ${db})`);
  connectProbe();
  poll();
});
