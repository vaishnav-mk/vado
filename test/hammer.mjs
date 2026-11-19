// Concurrency invariants against any Redis endpoint (local TCP, or prod through scripts/ws-shim.mjs).
// Each check must hold even with shards being reset underneath it (CHAOS=1 aborts shards via the
// bench API while checks run): acknowledged effects are never lost, and anything that failed
// (LOST, reconnect) may or may not have applied, so bounds are [acked, acked + failed].
//
//   PORT=6399 PW=... DB=hammer1 C=32 SECONDS=60 CHAOS=1 BASE=https://<your-worker>.workers.dev TOKEN=... node test/hammer.mjs
import Redis from "ioredis";
import crypto from "node:crypto";

const env = process.env;
const PORT = Number(env.PORT ?? 6380), PW = env.PW || undefined, DB = env.DB ?? "hammer";
const C = Number(env.C ?? 16), SECONDS = Number(env.SECONDS ?? 20);
const BASE = env.BASE ?? "http://127.0.0.1:8787", TOKEN = env.TOKEN ?? "local";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = {}; // error message -> count, across all checks
const note = (e) => { const k = String(e?.message ?? e).slice(0, 60); errors[k] = (errors[k] ?? 0) + 1; };
const R = (o = {}) => new Redis({
  port: PORT, host: "127.0.0.1", username: PW ? DB : undefined, password: PW,
  maxRetriesPerRequest: 2, retryStrategy: (n) => Math.min(n * 100, 2000), enableAutoPipelining: false,
  // A command in flight when the connection drops may have run; resending it could apply it twice.
  autoResendUnfulfilledCommands: false,
  commandTimeout: Number(env.CMD_TIMEOUT ?? 60000), // a stall becomes a counted error, not a hang
  ...o,
});
const api = (path) => fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
const until = (ms) => { const end = Date.now() + ms; return () => Date.now() < end; };
// Setup and final reads retry: under chaos a single LOST shouldn't fail a whole check.
const retry = async (f, n = 8) => { for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= n) throw e; await sleep(250); } } };
function check(name, ok, detail) {
  results.push({ name, ok, ...detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
}

// Background chaos: abort one random shard (or all) every few seconds while the checks run.
let chaosRuns = 0, chaosStop = false;
async function chaos() {
  let db;
  while (!db && !chaosStop) db = await api(`/db?db=${DB}`).then((r) => r.db, () => sleep(1000));
  while (!chaosStop) {
    await sleep(3000 + Math.random() * 3000);
    if (chaosStop) break;
    const which = Math.random() < 0.2 ? "all" : String(Math.floor(Math.random() * db.shards));
    await api(`/abort?db=${DB}&shard=${which}`).catch(() => {});
    chaosRuns++;
  }
}

async function incr() {
  const clients = Array.from({ length: C }, () => R());
  const key = `incr:{c}`;
  await retry(() => clients[0].del(key));
  let acked = 0, failed = 0;
  const go = until(SECONDS * 1000 / 4);
  await Promise.all(clients.map(async (c) => {
    while (go()) {
      try { await c.incr(key); acked++; } catch (e) { note(e); failed++; }
    }
  }));
  const final = Number(await retry(() => clients[0].get(key)));
  check("concurrent INCR is exact", final >= acked && final <= acked + failed, { acked, failed, final });
  clients.forEach((c) => c.disconnect());
}

async function bank() {
  const N = 10, START = 1000, key = (i) => `acct:{bank}:${i}`;
  const clients = Array.from({ length: C }, () => R());
  await retry(() => clients[0].mset(...Array.from({ length: N }, (_, i) => [key(i), START]).flat()));
  let commits = 0, conflicts = 0, failed = 0;
  const go = until(SECONDS * 1000 / 4);
  await Promise.all(clients.map(async (c) => {
    while (go()) {
      const a = Math.floor(Math.random() * N), b = (a + 1 + Math.floor(Math.random() * (N - 1))) % N, amt = 1 + Math.floor(Math.random() * 10);
      try {
        await c.watch(key(a), key(b));
        const [x, y] = (await c.mget(key(a), key(b))).map(Number);
        if (x < amt) { await c.unwatch(); continue; }
        const r = await c.multi().set(key(a), x - amt).set(key(b), y + amt).exec();
        if (r === null) conflicts++; else commits++;
      } catch (e) { note(e); failed++; }
    }
  }));
  const vals = (await retry(() => clients[0].mget(...Array.from({ length: N }, (_, i) => key(i))))).map(Number);
  const sum = vals.reduce((s, v) => s + v, 0);
  check("WATCH/MULTI transfers conserve money", sum === N * START && vals.every((v) => v >= 0), { sum, expected: N * START, commits, conflicts, failed });
  clients.forEach((c) => c.disconnect());
}

// Reliable-queue pattern: BLMOVE into a per-consumer processing list in the same slot, so a pop
// whose reply is lost (shard reset after the move) leaves the item in that list, not gone. Every
// acknowledged push must end up consumed, in a processing list, or still queued.
async function queue() {
  const P = Math.max(2, C / 2), Q = Math.max(2, C / 2), q = `queue:{q}`, PER = 200;
  const proc = (i) => `queue:{q}:processing:${i}`;
  const clients = Array.from({ length: P + Q + 1 }, () => R());
  await retry(() => clients[0].del(q, ...Array.from({ length: Q }, (_, i) => proc(i))));
  const pushed = new Set(), pushFailed = new Set(), got = [];
  let popFailed = 0, done = false;
  const producers = clients.slice(1, P + 1).map(async (c, p) => {
    for (let i = 0; i < PER; i++) {
      const id = `${p}:${i}`;
      try { await c.lpush(q, id); pushed.add(id); } catch (e) { note(e); pushFailed.add(id); }
    }
  });
  const consumers = clients.slice(P + 1).map(async (c, i) => {
    while (!done) {
      try {
        const id = await c.blmove(q, proc(i), "RIGHT", "LEFT", 1);
        if (id) { got.push(id); await c.lrem(proc(i), 1, id); } // processed: acknowledge
      } catch (e) { note(e); popFailed++; }
    }
  });
  await Promise.all(producers);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && (await clients[0].llen(q).catch(() => 1)) > 0) await sleep(200);
  await sleep(1500);
  done = true;
  await Promise.all(consumers);
  const inFlight = (await Promise.all(Array.from({ length: Q }, (_, i) => retry(() => clients[0].lrange(proc(i), 0, -1))))).flat();
  const left = await retry(() => clients[0].lrange(q, 0, -1));
  const seen = new Set([...got, ...inFlight, ...left]);
  const lost = [...pushed].filter((x) => !seen.has(x));
  check("queue loses no acknowledged item", lost.length === 0, { total: P * PER, pushed: pushed.size, pushFailed: pushFailed.size, consumed: got.length, uniqueConsumed: new Set(got).size, inProcessing: inFlight.length, stillQueued: left.length, popFailed, lost: lost.length, lostSample: lost.slice(0, 5) });
  clients.forEach((c) => c.disconnect());
}

async function pubsub() {
  const S = Math.min(C, 32), M = 300;
  const subs = Array.from({ length: S }, () => R());
  const pub = R();
  const seen = subs.map(() => []);
  await Promise.all(subs.map((s, i) => { s.on("message", (_ch, m) => seen[i].push(Number(m))); return s.subscribe("fan:{p}"); }));
  await sleep(300);
  let sent = 0;
  for (let i = 0; i < M; i++) { try { await pub.publish("fan:{p}", String(i)); sent++; } catch (e) { note(e); /* counted below */ } }
  await sleep(2000);
  const complete = seen.filter((xs) => xs.length === M).length;
  const ordered = seen.every((xs) => xs.every((v, k) => k === 0 || v > xs[k - 1]));
  // Under chaos a subscriber whose pub/sub object was reset misses messages (pub/sub is fire-and-forget).
  check("pub/sub fan-out is complete and ordered", ordered && (env.CHAOS || complete === S), { subscribers: S, sent, complete, ordered });
  [...subs, pub].forEach((c) => c.disconnect());
}

async function lua() {
  const clients = Array.from({ length: C }, () => R());
  const h = "lua:{h}";
  await retry(() => clients[0].del(h));
  const script = "local a = redis.call('HINCRBY', KEYS[1], 'a', 1); local b = redis.call('HINCRBY', KEYS[1], 'b', 1); return a - b";
  let acked = 0, failed = 0, skew = 0;
  const go = until(SECONDS * 1000 / 8);
  await Promise.all(clients.map(async (c) => {
    while (go()) {
      try { if ((await c.eval(script, 1, h)) !== 0) skew++; acked++; } catch (e) { note(e); failed++; }
    }
  }));
  const { a, b } = await retry(() => clients[0].hgetall(h));
  check("Lua scripts are atomic", skew === 0 && a === b && Number(a) >= acked && Number(a) <= acked + failed, { acked, failed, a, b, skew });
  clients.forEach((c) => c.disconnect());
}

async function zset() {
  const clients = Array.from({ length: C }, () => R());
  const z = "lb:{z}", members = 50;
  await retry(() => clients[0].del(z));
  let acked = 0, failed = 0;
  const go = until(SECONDS * 1000 / 8);
  await Promise.all(clients.map(async (c) => {
    while (go()) {
      try { await c.zincrby(z, 1, `m${Math.floor(Math.random() * members)}`); acked++; } catch (e) { note(e); failed++; }
    }
  }));
  const all = await retry(() => clients[0].zrange(z, 0, -1, "WITHSCORES"));
  let sum = 0;
  for (let i = 1; i < all.length; i += 2) sum += Number(all[i]);
  check("sorted-set increments add up", sum >= acked && sum <= acked + failed, { acked, failed, sum });
  clients.forEach((c) => c.disconnect());
}

async function bigValues() {
  const c = R({ maxRetriesPerRequest: 0 });
  const out = {};
  let ok = true;
  for (const mb of [1, 4, 16]) {
    const v = crypto.randomBytes(mb << 20);
    const key = `big:${mb}`;
    try {
      await c.set(key, v);
      const back = await c.getBuffer(key);
      const same = Buffer.compare(v, back) === 0;
      out[`${mb}MB`] = same ? "ok" : "MISMATCH";
      ok &&= same;
      await c.del(key);
    } catch (e) { out[`${mb}MB`] = e.message.slice(0, 80); ok &&= !!env.CHAOS; }
  }
  check("large values round-trip", ok, out);
  c.disconnect();
}

async function expiry() {
  const c = R();
  const n = 200;
  const p = c.pipeline();
  for (let i = 0; i < n; i++) p.set(`exp:${i}`, "x", "PX", 300);
  await p.exec();
  const live = (await retry(() => c.mget(...Array.from({ length: n }, (_, i) => `exp:${i}`)))).filter(Boolean).length;
  await sleep(1200);
  const left = (await retry(() => c.mget(...Array.from({ length: n }, (_, i) => `exp:${i}`)))).filter(Boolean).length;
  check("PX expiry", left === 0 && live > 0, { setThenLive: live, afterExpiry: left });
  c.disconnect();
}

async function pipelines() {
  const c = R();
  const n = 20000, p = c.pipeline();
  for (let i = 0; i < n; i++) {
    if (i % 4 === 0) p.set(`pl:${i}`, String(i));
    else if (i % 4 === 1) p.get(`pl:${i - 1}`);
    else if (i % 4 === 2) p.hset(`plh:{${i % 97}}`, `f${i}`, String(i));
    else p.sadd(`pls:{${i % 89}}`, String(i));
  }
  const t0 = Date.now();
  const r = await p.exec();
  const ms = Date.now() - t0;
  const errors = r.filter(([e]) => e).length;
  const getsOk = r.every(([, v], i) => i % 4 !== 1 || v === String(i - 1));
  check("20k-command mixed pipeline", errors === 0 && getsOk, { ms, errors, opsPerSec: Math.round(n / ms * 1000) });
  c.disconnect();
}

async function churn() {
  const n = Number(env.CHURN ?? 200);
  let ok = 0, bad = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: n }, async (_, i) => {
    const c = R({ maxRetriesPerRequest: 0, retryStrategy: () => null, lazyConnect: true });
    try { await c.connect(); await c.set(`churn:${i}`, "1"); if ((await c.get(`churn:${i}`)) === "1") ok++; else bad++; } catch (e) { note(e); bad++; }
    c.disconnect();
  }));
  check("connection churn (connect, AUTH, write, read, close)", bad === 0 || !!env.CHAOS, { connections: n, ok, bad, ms: Date.now() - t0 });
}

const only = env.ONLY?.split(",");
const all = { incr, bank, queue, pubsub, lua, zset, bigValues, expiry, pipelines, churn };
const t0 = Date.now();
const chaosTask = env.CHAOS ? chaos() : null;
for (const [name, fn] of Object.entries(all)) {
  if (only && !only.includes(name)) continue;
  const limit = (SECONDS * 2 + 180) * 1000;
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`stage timed out after ${limit / 1000}s`)), limit); })]);
  } catch (e) { check(name, false, { error: e.message }); }
  clearTimeout(timer);
}
chaosStop = true;
await chaosTask;
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: { checks: results.length, failed: failed.length, chaosAborts: chaosRuns, seconds: Math.round((Date.now() - t0) / 1000), errors } }));
process.exit(failed.length ? 1 : 0);
