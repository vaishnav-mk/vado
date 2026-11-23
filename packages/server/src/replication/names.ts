// Old and new code must agree on each of these across a deploy.
import type { Hint } from "../catalog/types";

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

export const replicaBinding = (k: number): ShardBinding => SHARD_BINDINGS[8 + k];

export const replicaDial = (deployedAt: number): string => `repl-${deployedAt}:6379`;

interface Namespace<Stub> {
  getByName(name: string, options: { locationHint: Hint }): Stub;
}

export const replicaOf = <Stub>(namespace: Namespace<Stub>, primary: string, region: Hint): Stub =>
  namespace.getByName(replicaName(primary, region), { locationHint: region });
