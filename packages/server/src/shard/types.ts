import type { Flavour } from "../catalog/types";
import type { ReplicaStatus } from "../replication/types";
import type { ValkeyHost } from "./host/valkey-host";

/** The last rewrite a ValkeyRewriter did for a shard: phase times from `at` (ms), bytes, and its error. */
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

/** What a restart onto newer code took, as the instance that restarted reported it. */
export interface UpgradeReport {
  from?: string;
  clients?: number;
  closed?: boolean;
  drainMs?: number;
  ms?: number;
}

/** The last restart onto newer code: the deploy it was for, when, and its report (if it got that far). */
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
  /** A primary's replicas; a replica has none. */
  replicas: ReplicaStatus[];
  lastRewrite: (RewriteLog & { doneMs: number | null }) | null;
  /** A replica: whether it serves reads. */
  ready?: boolean;
}

export interface DroppedStats {
  dropped: true;
  instance: string;
  isolate: string;
  files: [];
  replicas: [];
}

/** stats() without the file listing, plus Valkey's INFO fields. */
export type ShardSnapshot = Omit<ShardStats, "files"> & { info: Record<string, string> };
