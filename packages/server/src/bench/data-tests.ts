import type { RespClient } from "../protocol/resp-client";
import { noop } from "../shared";
import type { Test } from "./types";
import { alive, allShards, dbName, failure, num, open, pct } from "./util";

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

const durability: Test = async (env, q) => {
  const n = num(q, "n", 20000),
    batch = num(q, "batch", 500),
    tag = q.get("tag") ?? String(Date.now()),
    name = dbName(q);

  const c = await open(env, q);
  const acked = await writeKeys(c, "d", tag, n, batch);
  await c.call(["INCRBY", `d:${tag}:counter`, String(acked)]);
  c.close();
  const before = await alive(env, name);
  await allShards(env, name, (s) => s.abort("durability test").catch(noop));
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

// write + verify: durability split in two, so a deploy can happen in between.
const write: Test = async (env, q) => {
  const n = num(q, "n", 20000),
    c = await open(env, q);

  const acked = await writeKeys(c, "w", String(q.get("tag")), n, 500);
  c.close();

  return { n, acked, alive: await alive(env, dbName(q)) };
};

const verify: Test = async (env, q) => {
  const n = num(q, "n", 20000),
    c = await open(env, q);

  const { missing, wrong } = await checkKeys(c, "w", String(q.get("tag")), n);
  c.close();

  return { n, missing, wrong, alive: await alive(env, dbName(q)) };
};

// A failed SET (LOST: may or may not have run) owes nothing to the next read, so it's only counted.
async function eachSet(
  c: RespClient,
  q: URLSearchParams,
  prefix: string,
  then: (k: string, v: string, i: number, setMs: number) => Promise<void>,
) {
  const n = num(q, "n", 200),
    tag = q.get("prefix") ?? prefix;

  let failedWrites = 0;

  for (let i = 0; i < n; i++) {
    const k = `${tag}:${i % 20}`,
      v = `${tag}-${i}-${Date.now()}`,
      t0 = Date.now();

    const [set] = await c.call(["SET", k, v]);

    if (set === "OK") await then(k, v, i, Date.now() - t0);
    else failedWrites++;
  }

  return { n, failedWrites };
}

const ryw: Test = async (env, q) => {
  const c = await open(env, q);
  const samples: object[] = [];
  let stale = 0;

  const { n, failedWrites } = await eachSet(c, q, "ryw", async (k, v, i, setMs) => {
    const t1 = Date.now(),
      [got] = await c.call(["GET", k]);

    if (got === v) return;
    stale++;

    if (samples.length < 5) samples.push({ i, k, want: v, got, setMs, getMs: Date.now() - t1 });
  });

  c.close();

  return { n, stale, failedWrites, samples };
};

// How long after an acknowledged write another connection can still read the old value: 0 when reads go to the primary.
const staleness: Test = async (env, q) => {
  const a = await open(env, q),
    b = await open(env, q);

  const xs: number[] = [];

  let gaveUp = 0,
    firstRead = 0;

  const { n, failedWrites } = await eachSet(a, q, "stale", async (k, v) => {
    const acked = performance.now();

    for (let tries = 1; ; tries++) {
      const [got] = await b.call(["GET", k]);

      if (got === v) {
        xs.push(performance.now() - acked);

        if (tries === 1) firstRead++;

        return;
      }

      if (performance.now() - acked > 10000) {
        gaveUp++;

        return;
      }
    }
  });

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
