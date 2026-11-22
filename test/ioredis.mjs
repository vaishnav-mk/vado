// Stock ioredis against the TCP Worker. Exercises things a reimplementation usually lacks.
import Redis from "ioredis";
import assert from "node:assert/strict";

// PORT/PW/DB target another endpoint, e.g. prod through npx vado-shim (AUTH <DB> <PW>).
const opts = { port: Number(process.env.PORT ?? 6379), host: process.env.HOST ?? "127.0.0.1", maxRetriesPerRequest: 1, password: process.env.PW || undefined, username: process.env.PW ? process.env.DB ?? "default" : undefined };
const a = new Redis(opts), b = new Redis(opts), sub = new Redis(opts);

assert.equal(await a.ping(), "PONG");
assert.equal(await a.flushall(), "OK"); // fan-out to every shard
assert.equal(await a.dbsize(), 0);
assert.match(await a.info("server"), /(valkey|redis)_version:/); // either flavour
assert.match(await a.info("memory"), /maxmemory:67108864/); // boot config applied

await a.set("hello", "world");
assert.equal(await b.get("hello"), "world"); // other connection, same DO

await a.set("ttl", "x", "PX", 200);
await new Promise((r) => setTimeout(r, 400));
assert.equal(await b.get("ttl"), null); // expiry works

assert.deepEqual(await a.multi().incr("n").incr("n").exec(), [[null, 1], [null, 2]]);
assert.equal(await a.eval("return redis.call('INCRBY', KEYS[1], ARGV[1])", 1, "n", 40), 42); // Lua

const popped = b.blpop("q", 2); // blocking command, satisfied by another client
await a.lpush("q", "job1");
assert.deepEqual(await popped, ["q", "job1"]);

await a.xadd("s", "*", "k", "v");
assert.equal((await a.xrange("s", "-", "+")).length, 1); // streams

const got = new Promise((r) => sub.on("message", (_ch, msg) => r(msg)));
await sub.subscribe("ch");
await a.publish("ch", "hi");
assert.equal(await got, "hi"); // pub/sub

const N = 5000, t0 = performance.now();
const p = a.pipeline();
for (let i = 0; i < N; i++) p.set(`k${i}`, i);
await p.exec();
console.log(`all checks passed; ${N} pipelined SETs in ${(performance.now() - t0).toFixed(0)}ms`);
console.log("dbsize:", await a.dbsize());
a.disconnect(); b.disconnect(); sub.disconnect();
