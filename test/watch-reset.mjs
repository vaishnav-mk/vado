// A shard reset between WATCH and EXEC must abort the transaction, not run it unwatched on the new instance.
// BASE, TOKEN, HOST, PORT, DB, PW, FLAVOUR.
import assert from "node:assert/strict";
import { api, createDb, redis, sleep } from "./lib.mjs";

// Without VALKEY_PASSWORD on the Worker, any password selects the database.
const { DB = "watchreset", PW = "any" } = process.env;

await createDb(DB, 1);

const a = redis(DB, { username: DB, password: PW, maxRetriesPerRequest: 0 });

await a.set("k", "1");

await a.watch("k");

assert.equal(await a.get("k"), "1");

await api(`/abort?db=${DB}&shard=0`);

await sleep(300);

assert.equal(await a.multi().set("k", "unwatched").exec(), null, "EXEC after a lost WATCH must abort");

assert.equal(await a.get("k"), "1");

await a.watch("k");

assert.deepEqual(await a.multi().set("k", "2").exec(), [[null, "OK"]]);

assert.equal(await a.get("k"), "2");

await a.watch("k");

await api(`/abort?db=${DB}&shard=0`);

await sleep(300);

await a.unwatch();

assert.deepEqual(await a.multi().set("k", "3").exec(), [[null, "OK"]]);

a.disconnect();

console.log("watch-reset passed");
