// What storage, rewrites, memory and the RPC path cost on shard 0.
import { database } from "../catalog/databases";
import { shardStub } from "../catalog/placement";
import { command, concat } from "../protocol/resp";
import { decodeAll } from "../protocol/decode";
import type { Test } from "./types";
import { failure, liveStats, num, open, text } from "./util";
import { sleep } from "../shared";

const shardZero = async (env: Env, q: URLSearchParams) =>
  shardStub(env, await database(env, q.get("db") ?? "default"), 0);

// How long the shard's storage takes to confirm a write, from inside the object.
const commit: Test = async (env, q) => {
  const stub = await shardZero(env, q);
  await stub.stats(); // learn its colo
  const r = await stub.commitProbe(num(q, "n", 20));

  return { colo: r.colo, p50: r.ms[r.ms.length >> 1], min: r.ms[0], max: r.ms.at(-1) };
};

// Storage commit times for writing two mb MB files, then deleting the first (in the middle of the database) and the
// second (at its end).
const vfs: Test = async (env, q) => await (await shardZero(env, q)).vfsProbe(num(q, "mb", 32));

// BGREWRITEAOF while another client PINGs in a loop. replyMs is when the command answered; totalMs is when no
// rewrite is in progress any more.
const rewrite: Test = async (env, q) => {
  const stub = await shardZero(env, q),
    c = await open(env, q);

  const lat: number[] = [],
    slow: [number, number][] = []; // [ms after BGREWRITEAOF was sent, ping ms] for pings over 150 ms

  let stop = false,
    t0 = 0;

  const pinger = (async () => {
    while (!stop) {
      const t = Date.now();
      await c.call(["PING"]);
      const ms = Date.now() - t;
      lat.push(ms);

      if (ms > 150) slow.push([t - t0, ms]);
    }
  })();

  await sleep(500);
  t0 = Date.now();

  // runRaw: run's RPC result type is too deep for the checker, and it's the same reply.
  const [reply] = decodeAll(await stub.runRaw([["BGREWRITEAOF"]])),
    replyMs = Date.now() - t0;

  while (text(decodeAll(await stub.runRaw([["INFO", "persistence"]]))[0]).includes("aof_rewrite_in_progress:1"))
    await sleep(50);
  const totalMs = Date.now() - t0;
  await sleep(500);
  stop = true;
  await pinger;
  c.close();
  lat.sort((a, b) => a - b);

  const st = await liveStats(stub),
    base = st.files.find((f) => /\.base\./.test(f.path));

  return {
    reply,
    replyMs,
    totalMs,
    pings: lat.length,
    p50: lat[lat.length >> 1],
    p99: lat[Math.floor(lat.length * 0.99)],
    max: lat.at(-1),
    slow,
    base: base && { path: base.path, MB: +(base.size / 2 ** 20).toFixed(1) },
    helper: st.lastRewrite && { ...st.lastRewrite, at: st.lastRewrite.at - t0 },
  };
};

// Fragmentation: n keys with seeded random value sizes in [min, max], then `rounds` times delete a random half and
// rewrite it with sizes in [min2, max2] (default [min, max]). After each round: Valkey's used_memory vs the wasm
// memory it grew (which never shrinks, and is what counts against the isolate's memory). type=hash keeps the values
// as fields of small hashes (100 per key), which grow and shrink by realloc; rand=1 makes them incompressible.
// Run with via=shard.
const frag: Test = async (env, q) => {
  const n = num(q, "n", 150000),
    min = num(q, "min", 16),
    max = num(q, "max", 512),
    rounds = num(q, "rounds", 6);

  let seed = num(q, "seed", 1) >>> 0;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

  const min2 = num(q, "min2", min),
    max2 = num(q, "max2", max),
    hash = q.get("type") === "hash";

  const pool =
    q.get("rand") === "1" ? btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(3 << 10)))) : null;

  const val = (lo = min, hi = max) => {
    const len = lo + Math.floor(rnd() * (hi - lo + 1));

    if (!pool) return "x".repeat(len);
    const at = Math.floor(rnd() * (pool.length - len));

    return pool.slice(at, at + len);
  };

  const set = (i: number, v: string) =>
    hash ? ["HSET", `f:${Math.floor(i / 100)}`, String(i), v] : ["SET", `f:${i}`, v];

  const del = (i: number) => (hash ? ["HDEL", `f:${Math.floor(i / 100)}`, String(i)] : ["DEL", `f:${i}`]);

  const stub = await shardZero(env, q),
    c = await open(env, q);

  const mem = async (round: number | string) => {
    const info = text((await c.call(["INFO", "memory"]))[0]);
    const field = (k: string) => Number(new RegExp(`${k}:(\\d+)`).exec(info)?.[1] ?? NaN);

    const wasm = (await liveStats(stub)).wasmMemoryBytes,
      used = field("used_memory");

    return {
      round,
      usedMB: +(used / 2 ** 20).toFixed(1),
      wasmMB: +(wasm / 2 ** 20).toFixed(1),
      wasmPerUsed: +(wasm / used).toFixed(2),
      allocator: /mem_allocator:(\S+)/.exec(info)?.[1],
    };
  };

  const batch = async (cmds: string[][]) => {
    for (let i = 0; i < cmds.length; i += 1000) {
      const err = (await c.call(...cmds.slice(i, i + 1000))).map(failure).find((e) => e !== null);

      if (err) throw new Error(err);
    }
  };

  const out = [];
  await c.call(["FLUSHALL"]);
  out.push(await mem("empty"));
  await batch(Array.from({ length: n }, (_, i) => set(i, val())));
  out.push(await mem("filled"));

  for (let r = 1; r <= rounds; r++) {
    const pick = Array.from({ length: n }, (_, i) => i).filter(() => rnd() < 0.5);
    await batch(pick.map(del));
    await batch(pick.map((i) => set(i, val(min2, max2))));
    out.push(await mem(r));
  }

  c.close();

  return { n, min, max, min2, max2, type: hash ? "hash" : "string", rounds, memory: out };
};

// "+OK\r\n" frames in a reply.
function oks(r: Uint8Array): number {
  let n = 0;

  for (let i = 0; i < r.length; i += 5) n += r[i] === 43 ? 1 : 0;

  return n;
}

// One execRaw (the router's RPC mode) of k SETs straight to shard 0: are all k replies there?
const rpcbatch: Test = async (env, q) => {
  const k = num(q, "k", 1000),
    par = num(q, "par", 1);

  const body = concat(Array.from({ length: k }, (_, i) => command(["SET", `rb:${i}`, "v"])));

  const stub = await shardZero(env, q),
    t0 = Date.now();

  const rs = await Promise.allSettled(Array.from({ length: par }, () => stub.execRaw(body, k, 2)));

  return {
    k,
    par,
    bodyBytes: body.length,
    ms: Date.now() - t0,
    results: rs.map((r) =>
      r.status === "fulfilled"
        ? { bytes: r.value.length, frames: oks(r.value) }
        : { error: String(r.reason instanceof Error ? r.reason.message : r.reason) },
    ),
  };
};

export const shardProbes = { commit, vfs, rewrite, frag, rpcbatch };
