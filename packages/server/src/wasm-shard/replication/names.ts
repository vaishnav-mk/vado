import type { Hint } from "../../catalog/types";
import { SHARD_CLASSES } from "../config";
import type { Namespace } from "./types";

// Old and new code must agree on these names and bindings across a deploy.
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

export const replicaBinding = (k: number): ShardBinding => SHARD_BINDINGS[SHARD_CLASSES + k];

export const replicaOf = <Stub>(namespace: Namespace<Stub>, primary: string, region: Hint): Stub =>
  namespace.getByName(replicaName(primary, region), { locationHint: region });
