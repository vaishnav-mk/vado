// A shard reset between WATCH and EXEC must abort the transaction (null reply), not run it
// unwatched on the new instance (that was a lost-update bug found by test/hammer.mjs under chaos).
import Redis from "ioredis";
import assert from "node:assert/strict";

const HTTP = "http://127.0.0.1:8787", H = { authorization: "Bearer local" };
const api = (p) => fetch(HTTP + p, { headers: H }).then((r) => r.json());
await api("/db?db=watchreset&shards=1");
const PW = process.env.VALKEY_PASSWORD || "any"; // without VALKEY_PASSWORD any password selects the database
const a = new Redis({ port: 6380, host: "127.0.0.1", username: "watchreset", password: PW, maxRetriesPerRequest: 0 });
await a.set("k", "1");

// 1. reset between WATCH and MULTI/EXEC
await a.watch("k");
assert.equal(await a.get("k"), "1");
await api("/abort?db=watchreset&shard=0");
await new Promise((r) => setTimeout(r, 300));
assert.equal(await a.multi().set("k", "unwatched").exec(), null, "EXEC after a lost WATCH must abort");
assert.equal(await a.get("k"), "1");

// 2. the next normal transaction works again
await a.watch("k");
assert.deepEqual(await a.multi().set("k", "2").exec(), [[null, "OK"]]);
assert.equal(await a.get("k"), "2");

// 3. UNWATCH after a lost WATCH clears it
await a.watch("k");
await api("/abort?db=watchreset&shard=0");
await new Promise((r) => setTimeout(r, 300));
await a.unwatch();
assert.deepEqual(await a.multi().set("k", "3").exec(), [[null, "OK"]]);
a.disconnect();
console.log("watch-reset passed");
