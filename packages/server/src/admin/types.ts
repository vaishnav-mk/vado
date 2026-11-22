import type { ShardSnapshot } from "../shard/types";
import type { Replica, ShardUp } from "./live-types";

/** One open connection, as an isolate reports it to Pulse. */
export interface ReportedConnection {
  db: string;
  commands: number;
}

/** What an isolate running routers reports to Pulse every PULSE_MS. `done` counts commands of closed connections. */
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

/** A shard object that didn't answer. */
export interface Down {
  down: string;
}

export type ReplicaLook = { region: string } & (ShardSnapshot | Down);

/** One look at a primary (shardSnapshots): its snapshot with its ready replicas', or why it didn't answer. */
export type ShardLook = (ShardSnapshot | Down) & { replicaSnapshots: ReplicaLook[] };

/** Commands a server ran, as running totals. */
export interface Calls {
  reads: number;
  writes: number;
}

/** A shard as the page shows it, before the Watcher adds rates. `calls` are running totals. */
export type ShardReading = Omit<ShardUp, "ok" | "reads" | "writes" | "restartedAt" | "replicas"> & {
  instance: string;
  calls: Calls;
  replicas: (Replica & { instance: string | null })[];
};

/** Admin.create's input, as the dashboard's server function parsed it. */
export interface NewDatabase {
  name: string;
  shards: number;
  place: string;
  replicas: boolean;
  flavour?: string;
}
