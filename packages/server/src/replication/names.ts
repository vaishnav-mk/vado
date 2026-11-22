// How replicas are named, bound and dialed. Old and new code must agree on each of these across a deploy.
import type { Hint } from "../catalog/types";

/** The shard classes' bindings: SHARD + k for k < 8 holds primaries, SHARD + (8 + k) their replicas. */
export const SHARD_BINDINGS = [
  "SHARD",
  "SHARD1",
  "SHARD2",
  "SHARD3",
  "SHARD4",
  "SHARD5",
  "SHARD6",
  "SHARD7",
  "SHARD8",
  "SHARD9",
  "SHARD10",
  "SHARD11",
  "SHARD12",
  "SHARD13",
  "SHARD14",
  "SHARD15",
] as const;

export type ShardBinding = (typeof SHARD_BINDINGS)[number];

export const replicaName = (primary: string, region: string): string => `${primary}.r.${region}`;

export const isReplicaName = (name: string): boolean => /\.r\.[a-z-]+$/.test(name);

/** The class that holds the replicas of shard class k's primaries: never one a primary uses. */
export const replicaBinding = (k: number): ShardBinding => SHARD_BINDINGS[8 + k];

/** What a primary dials on its replica; a replica on older code restarts onto the newer code first. */
export const replicaDial = (deployedAt: number): string => `repl-${deployedAt}:6379`;

interface Namespace<Stub> {
  getByName(name: string, options: { locationHint: Hint }): Stub;
}

/** The replica of `primary` in `region`, placed there. */
export const replicaOf = <Stub>(namespace: Namespace<Stub>, primary: string, region: Hint): Stub =>
  namespace.getByName(replicaName(primary, region), { locationHint: region });
