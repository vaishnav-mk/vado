// Password mode, WebSocket ingress, idle upstream close, and SQLite rows per write.
// Needs local workerd started with VALKEY_PASSWORD set and a short ROUTER_IDLE_MS (scripts/test-local.sh).
import net from "node:net";
import { spawn } from "node:child_process";
import Redis from "ioredis";
import assert from "node:assert/strict";

const PW = process.env.VALKEY_PASSWORD;
const IDLE_MS = Number(process.env.ROUTER_IDLE_MS ?? 3000);
const HTTP = "http://127.0.0.1:8787", H = { authorization: "Bearer local" };
assert.ok(PW, "set VALKEY_PASSWORD");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (a) => `*${a.length}\r\n` + a.map((x) => `$${Buffer.byteLength(String(x))}\r\n${x}\r\n`).join("");
// Send raw commands in one write, collect whatever comes back within `ms`.
const raw = (cmds, port = 6380, ms = 400) => new Promise((res) => {
  const s = net.connect(port, "127.0.0.1");
  let out = "";
  s.on("data", (d) => (out += d));
  s.on("error", () => {}); // the server may close while we're still writing (oversized requests)
  s.write(cmds.map(enc).join(""));
  setTimeout(() => { s.destroy(); res(out); }, ms);
});
const get = (path) => fetch(HTTP + path, { headers: H }).then((r) => r.json());
const R = (o = {}) => new Redis({ port: 6380, host: "127.0.0.1", maxRetriesPerRequest: 1, password: PW, ...o });

// --- gate ---
assert.match(await raw([["PING"]]), /^-NOAUTH Authentication required/);
assert.match(await raw([["SET", "k", "v"]]), /^-NOAUTH/);
assert.match(await raw([["AUTH", "wrong"], ["PING"]]), /^-WRONGPASS.*\r\n-NOAUTH/s);
assert.match(await raw([["HELLO", "3"]]), /^-NOAUTH HELLO must be called/);
assert.match(await raw([["AUTH", "bad name!", PW]]), /^-ERR database names/);
assert.match(await raw([["AUTH", "MyDB", PW], ["PING"]]), /^-ERR database names.*\r\n-NOAUTH/s); // the catalog's rule, checked before any lookup
assert.match(await raw([["AUTH", PW], ["PING"]]), /^\+OK\r\n\+PONG\r\n$/);

// --- database selection by AUTH user, isolation, ordering across the async switch ---
const dflt = R(), x = R({ username: "authx" });
await dflt.set("k", "dflt");
await x.set("k", "x");
assert.equal(await x.get("k"), "x");
assert.equal(await dflt.get("k"), "dflt");
assert.equal(await raw([["AUTH", "authx", PW], ["GET", "k"], ["SET", "k2", "v"], ["GET", "k2"]]), "+OK\r\n$1\r\nx\r\n+OK\r\n$1\r\nv\r\n");
assert.match(await raw([["HELLO", "3", "AUTH", "authx", PW], ["GET", "k"]]), /^%.*server.*\r\n\$1\r\nx\r\n$/s);
const d2 = R({ username: "default" });
assert.equal(await d2.get("k"), "dflt");
d2.disconnect();
// Size limits: before AUTH a request is capped like Valkey's unauthenticated limits; after an AUTH
// that switches databases (async), the same write's next request already gets the full limit.
assert.equal(await raw([["ECHO", "x".repeat(100 << 10)]]), "-ERR Protocol error: invalid bulk length\r\n");
assert.equal(await raw([["AUTH", "authx", PW], ["SET", "big", "v".repeat(1 << 20)], ["STRLEN", "big"]], 6380, 3000), `+OK\r\n+OK\r\n:${1 << 20}\r\n`);
console.log("auth gate and database selection ok");

// --- WebSocket ingress through the shim ---
const shim = spawn(process.execPath, ["scripts/ws-shim.mjs", "ws://127.0.0.1:8787/ws", "6397"], { stdio: "ignore" });
try {
  await sleep(500);
  const W = (o = {}) => new Redis({ port: 6397, host: "127.0.0.1", maxRetriesPerRequest: 1, username: "wsdb", password: PW, ...o });
  const w = W(), w2 = W(), sub = W();
  assert.equal(await w.ping(), "PONG");
  await w.set("hello", "ws");
  assert.equal(await w2.get("hello"), "ws");
  const p = w.pipeline();
  for (let i = 0; i < 1000; i++) p.set(`p${i}`, String(i));
  assert.equal((await p.exec()).length, 1000);
  assert.equal(await w2.get("p999"), "999");
  assert.deepEqual(await w.mget("p1", "p2", "nope"), ["1", "2", null]);
  const got = new Promise((r) => sub.on("message", (_c, m) => r(m)));
  await sub.subscribe("chan");
  await w.publish("chan", "over-ws");
  assert.equal(await got, "over-ws");
  const pop = w2.blpop("q", 5);
  await sleep(100);
  await w.lpush("q", "job");
  assert.deepEqual(await pop, ["q", "job"]);
  assert.match(await raw([["PING"]], 6397), /^-NOAUTH/); // the gate applies over WebSocket too
  for (const c of [w, w2, sub]) c.disconnect();
  console.log("websocket ingress ok");
} finally {
  shim.kill();
}

// --- idle shard sockets close; the next command reopens them ---
await get("/db?db=idle1&shards=1");
const idle = R({ username: "idle1" });
await idle.set("a", "1");
let s = (await get("/stats?db=idle1")).shards[0];
assert.ok(s.sockets >= 1 && s.cronRunning, `expected an open upstream: ${JSON.stringify(s)}`);
await sleep(IDLE_MS + 5000);
s = (await get("/stats?db=idle1")).shards[0];
assert.equal(s.sockets, 0, `idle upstream still open: ${JSON.stringify(s)}`);
assert.equal(s.cronRunning, false);
assert.equal(await idle.get("a"), "1"); // client connection never noticed
console.log("idle upstream close ok");

// --- billed SQLite rows per unpipelined write ---
await get("/db?db=rows1&shards=1");
const rw = R({ username: "rows1" });
await rw.set("warm", "1");
const before = (await get("/stats?db=rows1")).shards[0].vfs.rowsWritten;
const N = 300;
for (let i = 0; i < N; i++) await rw.set(`r${i}`, "v".repeat(20));
const after = (await get("/stats?db=rows1")).shards[0].vfs.rowsWritten;
const perWrite = (after - before) / N;
console.log(`rows written per unpipelined SET: ${perWrite.toFixed(2)}`);
assert.ok(perWrite <= 1.1, `expected about 1 row per write, got ${perWrite}`);

for (const c of [dflt, x, idle, rw]) c.disconnect();
console.log("auth suite passed");
process.exit(0);
