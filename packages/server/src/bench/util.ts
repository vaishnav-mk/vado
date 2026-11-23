import { database } from "../catalog/databases";
import { shardStub } from "../catalog/placement";
import { RespClient } from "../protocol/resp-client";
import type { ShardStats } from "../shard/types";
import { openLocal } from "../router/local";

export const dbName = (q: URLSearchParams): string => q.get("db") ?? "default";

// via=shard goes straight to one shard's connect() (shard=<i>), with no router.
export async function open(env: Env, q: URLSearchParams, stallMs = 30_000): Promise<RespClient> {
  if (q.get("via") !== "shard") return openLocal(env, dbName(q), stallMs);
  const db = await database(env, dbName(q));

  return new RespClient(shardStub(env, db, Number(q.get("shard") ?? 0)).connect("valkey:6379"), stallMs);
}

export const num = (q: URLSearchParams, key: string, fallback: number): number => Number(q.get(key) ?? fallback);

// Sorts `xs` in place.
export const pct = (xs: number[], p: number): number | undefined =>
  xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

export async function allShards<T>(
  env: Env,
  name: string,
  fn: (stub: ReturnType<typeof shardStub>, i: number) => Promise<T>,
): Promise<T[]> {
  const db = await database(env, name);

  return Promise.all(Array.from({ length: db.shards }, (_, i) => fn(shardStub(env, db, i), i)));
}

// Seconds up per shard (null if dropped): a restart shows as a smaller number.
export const alive = (env: Env, name: string): Promise<(number | null)[]> =>
  allShards(env, name, async (s) => {
    const stats = await s.stats();

    return "dropped" in stats ? null : stats.aliveSeconds;
  });

export async function liveStats(stub: ReturnType<typeof shardStub>): Promise<ShardStats> {
  const stats = await stub.stats();

  if ("dropped" in stats) throw new Error("the shard was dropped");

  return stats;
}
