// Stock ioredis over TCP: HOST, PORT, PW, DB.
import assert from "node:assert/strict";
import { redis, sleep } from "./lib.mjs";

const db = process.env.DB ?? "default";

const a = redis(db, { maxRetriesPerRequest: 1 }),
  b = redis(db, { maxRetriesPerRequest: 1 }),
  sub = redis(db, { maxRetriesPerRequest: 1 });

assert.equal(await a.ping(), "PONG");

assert.equal(await a.flushall(), "OK");

assert.equal(await a.dbsize(), 0);

assert.match(await a.info("server"), /(valkey|redis)_version:/);

assert.match(await a.info("memory"), /maxmemory:67108864/);

await a.set("hello", "world");

assert.equal(await b.get("hello"), "world");

await a.set("ttl", "x", "PX", 200);

await sleep(400);

assert.equal(await b.get("ttl"), null);

assert.deepEqual(await a.multi().incr("n").incr("n").exec(), [
  [null, 1],
  [null, 2],
]);

assert.equal(await a.eval("return redis.call('INCRBY', KEYS[1], ARGV[1])", 1, "n", 40), 42);

const popped = b.blpop("q", 2);

await a.lpush("q", "job1");

assert.deepEqual(await popped, ["q", "job1"]);

await a.xadd("s", "*", "k", "v");

assert.equal((await a.xrange("s", "-", "+")).length, 1);

const got = new Promise((r) => sub.on("message", (_ch, msg) => r(msg)));

await sub.subscribe("ch");

await a.publish("ch", "hi");

assert.equal(await got, "hi");

const N = 5000,
  t0 = performance.now();

const p = a.pipeline();

for (let i = 0; i < N; i++) p.set(`k${i}`, i);

await p.exec();

console.log(`all checks passed; ${N} pipelined SETs in ${(performance.now() - t0).toFixed(0)}ms`);

console.log("dbsize:", await a.dbsize());

a.disconnect();

b.disconnect();

sub.disconnect();
