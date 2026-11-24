import type {
  Database,
  Entry,
  EventKind,
  EventLevel,
  Place,
  Replica,
  ReplicaState,
  Shard,
  ShardUp,
  TestView,
} from "../live-types";
import type { Down } from "../types";

export interface EventInput {
  level: EventLevel;
  kind: EventKind;
  text: string;
  shard?: number;
  region?: string;
}

export interface Restart {
  i: number;
  deploy: boolean;
  backMs: number | null;
}

export interface ReplicaChange {
  i: number;
  region: string;
  from: ReplicaState;
  to: ReplicaState;
  error: string | null;
}

export interface Rewrite {
  i: number;
  ms: number;
  bytes: number | null;
  error: string | null;
}

export interface Changes {
  restarts: Restart[];
  replicas: ReplicaChange[];
  rewrites: Rewrite[];
}

export interface Calls {
  reads: number;
  writes: number;
}

// Before the Watcher turns the running totals in `calls` into rates.
export type ShardReading = Omit<ShardUp, "ok" | "reads" | "writes" | "restartedAt" | "replicas"> & {
  instance: string;
  calls: Calls;
  replicas: (Replica & { instance: string | null })[];
};

export type ShardSeen = ShardReading | (Down & { i: number });

export interface TrackedReplica {
  state: ReplicaState | null;
  instance: string | null;
  points: { at: number; reads: number }[];
}

export interface Tracked {
  points: { at: number; reads: number; writes: number }[];
  replicas: Map<string, TrackedReplica>;
  down: boolean;
  instance: string | null;
  version: string | null;
  place: Place;
  restartedAt: number;
  memoryHigh: boolean;
  rewriteAt: number | undefined; // undefined: none seen yet
}

export interface Look {
  shards: Shard[];
  changes: Changes;
  alerts: EventInput[];
}

export type ProbeSample = { readMs: number; writeMs: number | null } | { failed: true };

export interface Reading {
  at: number;
  error: string | null;
  db: Database | null;
  watcher: Place | null;
  shards: Shard[];
  entries: Entry[];
  probes: ProbeSample[];
  probeAt: { shard: number; replica: string | null } | null;
  writes: boolean;
  test: TestView | null;
}
