// The same seeded commands on a 1-shard and an N-shard database must get the same replies, unordered sets sorted.
// BASE, TOKEN, FLAVOUR: node test/differential.mjs [seed] [rounds] [shards]
import assert from "node:assert/strict";
import { api, createDb } from "./lib.mjs";

const seed = Number(process.argv[2] ?? 1),
  rounds = Number(process.argv[3] ?? 40),
  shards = Number(process.argv[4] ?? 16);

const run = Date.now().toString(36);

const dbA = `diff-${run}-a`,
  dbB = `diff-${run}-b`;

let s = seed >>> 0;
const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (n) => Math.floor(rnd() * n);
const tags = ["{u1}", "{u2}", "{u3}", ""];
const key = () => `${pick(tags)}k${int(12)}`;
const tagged = (t) => `${t}k${int(12)}`;
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const val = () => pick(["a", "bb", "ccc", String(int(100)), "x".repeat(int(40))]);

const gens = [
  () => [["SET", key(), val()]],
  () => [["GET", key()]],
  () => [["INCR", `n${int(5)}`]],
  () => [["INCRBY", `n${int(5)}`, String(int(9))]],
  () => [["APPEND", key(), val()]],
  () => [["STRLEN", key()]],
  () => [["GETDEL", key()]],
  () => [["TYPE", key()]],
  () => [["MSET", key(), val(), key(), val(), key(), val()]],
  () => [["MGET", key(), key(), key(), key()]],
  () => [["DEL", key(), key(), key()]],
  () => [["EXISTS", key(), key(), key()]],
  () => [["TOUCH", key(), key()]],
  () => [["UNLINK", key()]],
  () => [["HSET", `h${int(4)}`, `f${int(6)}`, val()]],
  () => [["HGETALL", `h${int(4)}`]],
  () => [["HDEL", `h${int(4)}`, `f${int(6)}`]],
  () => [["HINCRBY", `h${int(4)}`, "c", "1"]],
  () => [["RPUSH", `l${int(3)}`, val(), val()]],
  () => [["LPOP", `l${int(3)}`]],
  () => [["LRANGE", `l${int(3)}`, "0", "-1"]],
  () => [["SADD", `s${int(3)}`, val(), val()]],
  () => [["SMEMBERS", `s${int(3)}`]],
  () => [["SREM", `s${int(3)}`, val()]],
  () => [["SCARD", `s${int(3)}`]],
  () => [["ZADD", `z${int(3)}`, String(int(50)), val()]],
  () => [["ZRANGE", `z${int(3)}`, "0", "-1", "WITHSCORES"]],
  () => [["ZINCRBY", `z${int(3)}`, "2", val()]],
  () => {
    const t = pick(tags.slice(0, 3));

    return [["RENAME", tagged(t), tagged(t)]];
  },
  () => {
    const t = pick(tags.slice(0, 3));

    return [["SUNIONSTORE", `${t}dst`, `${t}s1`, `${t}s2`]];
  },
  () => {
    const t = pick(tags.slice(0, 3));

    return [["MULTI"], ["INCR", `${t}tx`], ["SET", tagged(t), val()], ["GET", `${t}tx`], ["EXEC"]];
  },
  () => {
    const t = pick(tags.slice(0, 3));

    return [
      [
        "EVAL",
        "redis.call('SET', KEYS[1], ARGV[1]); return redis.call('GET', KEYS[2])",
        "2",
        tagged(t),
        tagged(t),
        val(),
      ],
    ];
  },
  () => [["DBSIZE"]],
  () => [["KEYS", "*"]],
  () => [["SCANALL"]],
  () => [["SET", key(), val(), "NX"]],
  () => [["GETRANGE", key(), "0", "2"]],
  () => [["SETRANGE", key(), "1", "zz"]],
  () => [["LMOVE", "{u1}l1", "{u1}l2", "LEFT", "RIGHT"]],
  () => [["SMOVE", "{u2}s1", "{u2}s2", val()]],
  () => [["EXPIRE", key(), "100000"]],
  () => [["TTL", key()]],
  () => [["PERSIST", key()]],
];

async function call(db, cmds) {
  const body = await api(`/run?db=${db}`, { method: "POST", body: JSON.stringify(cmds) });

  if (body.error) throw new Error(`${db}: ${body.error}`);

  return body.replies;
}

async function scanAll(db) {
  const keys = [];
  let cursor = "0";

  do {
    const [[next, batch]] = await call(db, [["SCAN", cursor, "COUNT", "7"]]);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== "0");

  return keys.sort(byCodeUnits);
}

const norm = (c, r) => {
  const name = c[0];

  if (["SMEMBERS", "KEYS"].includes(name) && Array.isArray(r)) return [...r].sort(byCodeUnits);

  if (name === "HGETALL" && Array.isArray(r)) {
    const p = [];

    for (let i = 0; i < r.length; i += 2) p.push(`${r[i]}=${r[i + 1]}`);

    return p.sort(byCodeUnits);
  }

  if (name === "TTL" && r > 0) return "ttl>0"; // r is an integer or { err }, and { err } > 0 is false

  return r;
};

console.log((await createDb(dbA, 1)).db, (await createDb(dbB, shards)).db);

let checked = 0,
  crossSlotRejections = 0;

for (let round = 0; round < rounds; round++) {
  const batch = [];

  for (let i = 0; i < 25; i++) batch.push(pick(gens)());

  for (const cmds of batch) {
    if (cmds[0][0] === "SCANALL") {
      assert.deepEqual(await scanAll(dbB), await scanAll(dbA), "SCAN full iteration differs");
      checked++;
      continue;
    }

    const [a, b] = await Promise.all([call(dbA, cmds), call(dbB, cmds)]);

    // A cross-slot transaction is allowed on 1 shard and rejected (EXECABORT) on many: skip, but count it.
    if (b.some((r) => r?.err?.startsWith("CROSSSLOT"))) {
      crossSlotRejections++;

      if (cmds[0][0] === "MULTI") continue;
    }

    for (let i = 0; i < cmds.length; i++) {
      assert.deepEqual(
        norm(cmds[i], b[i]),
        norm(cmds[i], a[i]),
        `round ${round}: ${JSON.stringify(cmds[i])}\n 1 shard: ${JSON.stringify(a[i])}\n ${shards} shards: ${JSON.stringify(b[i])}`,
      );
      checked++;
    }
  }
}

const [[sa], [sb]] = await Promise.all([call(dbA, [["DBSIZE"]]), call(dbB, [["DBSIZE"]])]);

console.log(JSON.stringify({ seed, rounds, shards, checked, crossSlotRejections, dbsizeA: sa, dbsizeB: sb }));

console.log("differential test passed");
