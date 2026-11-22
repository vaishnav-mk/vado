// Load: throughput, latency, filling a database, connection churn, and stock ioredis.
import type { RespClient } from "../protocol/resp-client";
import type { Reply } from "../protocol/types";
import { connectLocal } from "../router/local";
import type { Test } from "./types";
import { failure, num, open, pct } from "./util";

// Pipelined SETs across `conns` connections, keys spread over every slot; checks every reply. op=get reads the same
// keys back; keys=<m> reuses m keys per connection.
const throughput: Test = async (env, q) => {
  const n = num(q, "n", 100000),
    batch = num(q, "batch", 1000),
    conns = num(q, "conns", 1);

  const size = num(q, "value", 1),
    v = "v".repeat(size),
    get = q.get("op") === "get";

  const keys = num(q, "keys", Infinity),
    prefix = q.get("prefix") ?? "t",
    key = (ci: number, j: number) => `${prefix}${ci}:${j % keys}`;

  const cs = await Promise.all(Array.from({ length: conns }, () => open(env, q)));
  await Promise.all(cs.map((c) => c.call(["PING"])));

  let errors = 0,
    firstError: Reply | null = null,
    hits = 0;

  const t0 = performance.now();
  await Promise.all(
    cs.map(async (c, ci) => {
      for (let i = 0; i < n / conns; i += batch) {
        const rs = await c.call(
          ...Array.from({ length: batch }, (_, k) => (get ? ["GET", key(ci, i + k)] : ["SET", key(ci, i + k), v])),
        );

        for (const r of rs)
          if (get ? failure(r) !== null : r !== "OK") {
            errors++;
            firstError ??= r;
          } else if (get && r === v) hits++;
      }
    }),
  );
  const ms = performance.now() - t0;

  for (const c of cs) c.close();
  const out = { n, batch, conns, valueBytes: size, ms, opsPerSec: Math.round((n / ms) * 1000), errors, firstError };

  return get ? { ...out, hits } : out;
};

const latency: Test = async (env, q) => {
  const n = num(q, "n", 200),
    c = await open(env, q);

  const t0 = performance.now();
  await c.call(["PING"]);

  const first = performance.now() - t0,
    xs: number[] = [];

  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await c.call(["GET", `lat:${i}`]);
    xs.push(performance.now() - t);
  }

  c.close();

  return { firstMs: first, n, p50: pct(xs, 0.5), p99: pct(xs, 0.99), max: Math.max(...xs) };
};

// Fill with `value`-byte strings until Valkey refuses (OOM) or a connection dies.
const fill: Test = async (env, q) => {
  const c = await open(env, q),
    size = num(q, "value", 65536),
    v = "x".repeat(size),
    limitKeys = num(q, "max", 1e9);

  let keys = 0,
    stop: string | null = null;

  try {
    while (keys < limitKeys) {
      const rs = await c.call(...Array.from({ length: 16 }, () => ["SET", `f${keys++}`, v]));
      const err = rs.map(failure).find((e) => e !== null);

      if (err) {
        stop = err;
        break;
      }
    }
  } catch (e) {
    stop = `connection: ${e instanceof Error ? e.message : String(e)}`;
  }

  c.close();
  const c2 = await open(env, q);
  const [dbsize] = await c2.call(["DBSIZE"]);
  c2.close();

  return {
    valueBytes: size,
    keysAttempted: keys,
    stoppedBy: stop,
    dbsize,
    approxMB: Math.round((Number(dbsize) * size) / 1048576),
  };
};

// Connection churn from inside Cloudflare (the router's own connect handler, no TCP ingress in between): n
// connections, par at a time, each AUTH, SET, GET, close. Compare with test/hammer or a client over TCP.
const churn: Test = async (env, q) => {
  const n = num(q, "n", 2000),
    par = num(q, "par", 50),
    fails: [number, string][] = [];

  let next = 0,
    ok = 0;

  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: par }, async () => {
      for (let i = next++; i < n; i = next++) {
        let c: RespClient | null = null;

        try {
          c = await open(env, q);
          const [set, get] = await c.call(["SET", `churn:${i}`, `v${i}`], ["GET", `churn:${i}`]);

          if (set !== "OK" || get !== `v${i}`) throw new Error(`replies ${JSON.stringify([set, get])}`);
          ok++;
        } catch (e) {
          if (fails.length < 20) fails.push([i, e instanceof Error ? e.message : String(e)]);
        } finally {
          c?.close();
        }
      }
    }),
  );

  return { n, ok, failed: n - ok, ms: Date.now() - t0, fails };
};

interface IoredisResult {
  ping?: string;
  set?: string | null;
  get?: string | null;
  mget?: (string | null)[];
  multi?: [Error | null, unknown][] | null;
  eval?: unknown;
  blpop?: [string, string] | null;
  pubsub?: string;
  pipeline?: number;
  pipelineMs?: number;
  error?: string;
}

// Stock ioredis inside this Worker, through @vado/client's connector to a router in this isolate. Imported here
// so nothing else in the Worker loads it.
const ioredis: Test = async (env, q) => {
  const [{ default: Redis }, { bindingConnector }] = await Promise.all([import("ioredis"), import("@vado/client")]);

  const db = q.get("db") ?? "default",
    k = `io:${Date.now()}`;

  const options = {
    Connector: bindingConnector({ connect: () => connectLocal(env, db) }, db),
    maxRetriesPerRequest: 1,
    password: env.VALKEY_PASSWORD || undefined,
  };

  const a = new Redis(options),
    b = new Redis(options),
    sub = new Redis(options);

  const out: IoredisResult = {};

  try {
    out.ping = await a.ping();
    out.set = await a.set(`${k}:s`, "v", "PX", 60000);
    out.get = await b.get(`${k}:s`);
    out.mget = await a.mget(`${k}:s`, `${k}:missing`, `{${k}}x`);
    out.multi = await a.multi().incr(`{${k}}n`).incr(`{${k}}n`).exec();
    out.eval = await a.eval("return redis.call('INCRBY', KEYS[1], ARGV[1])", 1, `{${k}}n`, 40);
    const popped = b.blpop(`${k}:q`, 5);
    await a.lpush(`${k}:q`, "job");
    out.blpop = await popped;
    const got = new Promise<string>((resolve) => sub.on("message", (_channel: string, m: string) => resolve(m)));
    await sub.subscribe(`${k}:ch`);
    await a.publish(`${k}:ch`, "hi");
    out.pubsub = await got;
    const p = a.pipeline();

    for (let i = 0; i < 1000; i++) p.set(`${k}:p${i}`, i);
    const t0 = Date.now();
    out.pipeline = ((await p.exec()) ?? []).filter(([e, r]) => !e && r === "OK").length;
    out.pipelineMs = Date.now() - t0;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }

  a.disconnect();
  b.disconnect();
  sub.disconnect();

  return out;
};

export const loadTests = { throughput, latency, fill, churn, ioredis };
