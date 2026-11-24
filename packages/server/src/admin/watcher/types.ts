import type { Database, Entry, EventKind, EventLevel, Place, Shard, TestView } from "../live-types";

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
  from: string;
  to: string;
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
