import type { ShardSnapshot } from "../shard/types";

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

export interface NewDatabase {
  name: string;
  shards: number;
  place: string;
  replicas: boolean;
  flavour?: string;
}
