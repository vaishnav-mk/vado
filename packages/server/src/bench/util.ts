import { database } from "../catalog/databases";
import { shardStub } from "../catalog/placement";
import { RespClient } from "../protocol/resp-client";
import type { ShardStats } from "../shard/types";
import { openLocal } from "../router/local";

export const dbName = (q: URLSearchParams): string => q.get("db") ?? "default";

// via=shard goes straight to one shard's connect() (shard=<i>), with no router.
export async function open(env: Env, q: URLSearchParams): Promise<RespClient> {
  if (q.get("via") !== "shard") return openLocal(env, dbName(q));
  const db = await database(env, dbName(q));

  return new RespClient(shardStub(env, db, Number(q.get("shard") ?? 0)).connect("valkey:6379"));
}

export const num = (q: URLSearchParams, key: string, fallback: number): number => Number(q.get(key) ?? fallback);

export const mb = (bytes: number): number => +(bytes / 2 ** 20).toFixed(1);

export async function allShards<T>(
  env: Env,
  name: string,
  fn: (stub: ReturnType<typeof shardStub>) => Promise<T>,
): Promise<T[]> {
  const db = await database(env, name);

  return Promise.all(Array.from({ length: db.shards }, (_, i) => fn(shardStub(env, db, i))));
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
