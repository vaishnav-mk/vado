// Data: is every acknowledged write there after resets and deploys, and does a reader see it?
import type { RespClient } from "../protocol/resp-client";
import type { Test } from "./types";
import { alive, allShards, failure, num, open, pct } from "./util";

/** SETs `<prefix>:<tag>:<i>` to `<tag>-<i>` for i below n, `batch` at a time; returns how many were acknowledged. */
async function writeKeys(c: RespClient, prefix: string, tag: string, n: number, batch: number): Promise<number> {
  let acked = 0;

  for (let i = 0; i < n; i += batch) {
    const rs = await c.call(
      ...Array.from({ length: Math.min(batch, n - i) }, (_, k) => [
        "SET",
        `${prefix}:${tag}:${i + k}`,
        `${tag}-${i + k}`,
      ]),
    );

    acked += rs.filter((r) => r === "OK").length;
  }

  return acked;
}

/** Reads back what writeKeys wrote. */
async function checkKeys(c: RespClient, prefix: string, tag: string, n: number) {
  let missing = 0,
    wrong = 0;

  for (let i = 0; i < n; i += 1000) {
    const [vals] = await c.call([
      "MGET",
      ...Array.from({ length: Math.min(1000, n - i) }, (_, k) => `${prefix}:${tag}:${i + k}`),
    ]);

    if (!Array.isArray(vals)) throw new Error(failure(vals) ?? "MGET didn't return an array");
    vals.forEach((v, k) => {
      if (v === null) missing++;
      else if (v !== `${tag}-${i + k}`) wrong++;
    });
  }

  return { missing, wrong };
}

// Writes keys with known values, hard-resets every shard, then reads everything back.
const durability: Test = async (env, q) => {
  const n = num(q, "n", 20000),
    batch = num(q, "batch", 500),
    tag = q.get("tag") ?? String(Date.now()),
    name = q.get("db") ?? "default";

  const c = await open(env, q);
  const acked = await writeKeys(c, "d", tag, n, batch);
  await c.call(["INCRBY", `d:${tag}:counter`, String(acked)]);
  c.close();
  const before = await alive(env, name);
  await allShards(env, name, (s) => s.abort("durability test").catch(() => {}));
  const after = await alive(env, name);
  const c2 = await open(env, q);
  const { missing, wrong } = await checkKeys(c2, "d", tag, n);
  const [counter] = await c2.call(["GET", `d:${tag}:counter`]);
  c2.close();

  return {
    n,
    acked,
    missing,
    wrong,
    counter: Number(counter),
    restarted: after.every((a, i) => {
      const b = before[i];

      return a !== null && b !== null && a < b;
    }),
    aliveBefore: before,
    aliveAfter: after,
  };
};

// write + verify: durability split in two, so a deploy (or anything else) can happen in between.
const write: Test = async (env, q) => {
  const n = num(q, "n", 20000),
    c = await open(env, q);

  const acked = await writeKeys(c, "w", String(q.get("tag")), n, 500);
  c.close();

  return { n, acked, alive: await alive(env, q.get("db") ?? "default") };
};

const verify: Test = async (env, q) => {
  const n = num(q, "n", 20000),
    c = await open(env, q);

  const { missing, wrong } = await checkKeys(c, "w", String(q.get("tag")), n);
  c.close();

  return { n, missing, wrong, alive: await alive(env, q.get("db") ?? "default") };
};

// Read-your-writes on one connection: SET then GET the same key, n times. Every GET must see its SET.
const ryw: Test = async (env, q) => {
  const n = num(q, "n", 200),
    tag = q.get("prefix") ?? "ryw",
    c = await open(env, q);

  // A SET that failed (LOST: may or may not have run) owes nothing to the next read, so it's counted apart.
  let stale = 0,
    failedWrites = 0;

  const samples = [];

  for (let i = 0; i < n; i++) {
    const k = `${tag}:${i % 20}`,
      v = `${tag}-${i}`,
      t0 = Date.now();

    const [set] = await c.call(["SET", k, v]);

    const t1 = Date.now(),
      [got] = await c.call(["GET", k]);

    if (set !== "OK") failedWrites++;
    else if (got !== v) {
      stale++;

      if (samples.length < 5) samples.push({ i, k, want: v, got, setMs: t1 - t0, getMs: Date.now() - t1 });
    }
  }

  c.close();

  return { n, stale, failedWrites, samples };
};

// How long after an acknowledged write another client, on its own connection, can still read the old value: the
// replica lag a user sees. 0 when reads come from the primary.
const staleness: Test = async (env, q) => {
  const n = num(q, "n", 200),
    tag = q.get("prefix") ?? "stale",
    a = await open(env, q),
    b = await open(env, q);

  const xs: number[] = [];

  let failedWrites = 0,
    gaveUp = 0,
    firstRead = 0;

  for (let i = 0; i < n; i++) {
    const k = `${tag}:${i % 20}`,
      v = `${tag}-${i}-${Date.now()}`;

    const [set] = await a.call(["SET", k, v]);
    const acked = performance.now();

    if (set !== "OK") {
      failedWrites++;
      continue;
    }

    for (let tries = 1; ; tries++) {
      const [got] = await b.call(["GET", k]);

      if (got === v) {
        xs.push(performance.now() - acked);

        if (tries === 1) firstRead++;
        break;
      }

      if (performance.now() - acked > 10000) {
        gaveUp++;
        break;
      }
    }
  }

  a.close();
  b.close();
  const ms = (p: number) => Math.round(pct(xs, p) ?? NaN);

  return {
    n,
    p50: ms(0.5),
    p90: ms(0.9),
    p99: ms(0.99),
    max: Math.round(Math.max(...xs)),
    firstRead,
    failedWrites,
    gaveUp,
  };
};

export const dataTests = { durability, write, verify, ryw, staleness };
