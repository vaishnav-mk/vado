import { database } from "../catalog/databases";
import { shardStub } from "../catalog/placement";
import { RespClient } from "../protocol/resp-client";
import type { Reply } from "../protocol/types";
import type { ShardStats } from "../shard/types";
import { openLocal } from "../router/local";

/** A client on database `db`: via=router (default) a Router in this isolate, via=shard one shard's connect()
 *  (shard=<i>), no router. */
export async function open(env: Env, q: URLSearchParams, stallMs = 30_000): Promise<RespClient> {
  const name = q.get("db") ?? "default";

  if (q.get("via") !== "shard") return openLocal(env, name, stallMs);
  const db = await database(env, name);

  return new RespClient(shardStub(env, db, Number(q.get("shard") ?? 0)).connect("valkey:6379"), stallMs);
}

/** Query parameter `key` as a number, `fallback` when absent. */
export const num = (q: URLSearchParams, key: string, fallback: number): number => Number(q.get(key) ?? fallback);

/** Sorts `xs` and returns its `p` quantile. */
export const pct = (xs: number[], p: number): number | undefined =>
  xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

/** A reply that must be text, such as INFO's. */
export function text(r: Reply): string {
  if (r instanceof Object) throw new Error(failure(r) ?? "expected a text reply");

  return String(r);
}

/** The error a reply carries, or null. */
export const failure = (r: Reply): string | null => (r instanceof Object && "err" in r ? r.err : null);

export async function allShards<T>(
  env: Env,
  name: string,
  fn: (stub: ReturnType<typeof shardStub>, i: number) => Promise<T>,
): Promise<T[]> {
  const db = await database(env, name);

  return Promise.all(Array.from({ length: db.shards }, (_, i) => fn(shardStub(env, db, i), i)));
}

/** How long each shard of `name` has been up, in seconds (null if dropped): a restart shows as a smaller number. */
export const alive = (env: Env, name: string): Promise<(number | null)[]> =>
  allShards(env, name, async (s) => {
    const stats = await s.stats();

    return "dropped" in stats ? null : stats.aliveSeconds;
  });

/** A shard's stats, which a dropped shard doesn't have. */
export async function liveStats(stub: ReturnType<typeof shardStub>): Promise<ShardStats> {
  const stats = await stub.stats();

  if ("dropped" in stats) throw new Error("the shard was dropped");

  return stats;
}
