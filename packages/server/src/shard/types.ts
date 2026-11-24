import type { Flavour } from "../catalog/types";
import type { CommandArg, Protocol } from "../protocol/types";
import type { ReplicaStatus } from "../replication/types";
import type { ValkeyHost } from "./host/valkey-host";

export interface RewriteLog {
  at: number;
  rdb: boolean;
  ms?: number;
  error?: string;
  sentMs?: number;
  sentBytes?: number;
  headMs?: number;
  baseBytes?: number;
  receivedMs?: number;
  tailMs?: number;
}

export interface UpgradeReport {
  from?: string;
  clients?: number;
  closed?: boolean;
  drainMs?: number;
  ms?: number;
}

export type LastUpgrade = UpgradeReport & { deployed: number; at: number };

export interface ShardStats extends ReturnType<ValkeyHost["stats"]> {
  flavour: Flavour;
  instance: string;
  version: string;
  isolate: string;
  colo: string | null;
  aliveSeconds: number;
  restarting: boolean;
  lastUpgrade: LastUpgrade | null;
  files: ReturnType<ValkeyHost["files"]>;
  role: "primary" | "replica";
  replicas: ReplicaStatus[];
  lastRewrite: (RewriteLog & { doneMs: number | null }) | null;
  ready?: boolean;
}

export interface DroppedStats {
  dropped: true;
  instance: string;
  isolate: string;
  files: [];
  replicas: [];
}

export type ShardSnapshot = Omit<ShardStats, "files"> & { info: Record<string, string> };

// What every primary serves, in a Durable Object or a container: routers, the admin and the bench reach shards by it.
export interface Shard extends Rpc.DurableObjectBranded {
  execRaw(bytes: Uint8Array, count: number, proto?: Protocol): Promise<Uint8Array>;
  runRaw(cmds: CommandArg[][]): Promise<Uint8Array>;
  waitReplicas(n: number, ms: number): Promise<number>;
  instance(): string;
  snapshot(): Promise<ShardSnapshot>;
  stats(): ShardStats | DroppedStats;
  abort(reason?: string): Promise<void>;
  drop(): Promise<void>;
}
