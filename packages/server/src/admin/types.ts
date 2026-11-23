import type { ShardSnapshot } from "../shard/types";
import type { Replica, ShardUp } from "./live-types";

export interface ReportedConnection {
  db: string;
  commands: number;
}

// `done` counts commands of closed connections.
export interface IsolateReport {
  isolate: string;
  colo: string | null;
  conns: ReportedConnection[];
  done: Record<string, number>;
}

export interface PulseSnapshot {
  at: number;
  isolates: (IsolateReport & { at: number })[];
}

export interface Down {
  down: string;
}

export type ReplicaLook = { region: string } & (ShardSnapshot | Down);

export type ShardLook = (ShardSnapshot | Down) & { replicaSnapshots: ReplicaLook[] };

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

export interface NewDatabase {
  name: string;
  shards: number;
  place: string;
  replicas: boolean;
  flavour?: string;
}
