// Types only, so the browser can import it.
import type { Flavour } from "../catalog/types";
import type { TypedReply } from "../protocol/types";

export type { TypedReply };

export interface Place {
  colo: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
}

export interface Database {
  name: string;
  created: number;
  shards: number;
  regions: string[] | null;
  replicas: string[] | null;
  flavour: Flavour;
  password: boolean;
}

// `reads` includes what replicas served.
export interface Point {
  t: number;
  reads: number;
  writes: number;
  replicaReads: number;
  readMs: number | null;
  writeMs: number | null;
}

export type EventLevel = "info" | "success" | "warning" | "error";

export type EventKind = "action" | "test" | "deploy" | "restart" | "replica" | "rewrite" | "memory";

// A repeat comes again with the same id, a later t and a higher count.
export interface LiveEvent {
  id: number;
  t: number;
  level: EventLevel;
  kind: EventKind;
  text: string;
  shard?: number;
  region?: string;
  count: number;
}

export type ReplicaState = "ready" | "copying" | "catching up" | "idle" | "asleep";

export interface Replica extends Place {
  region: string;
  regionName: string;
  state: ReplicaState;
  lagMs: number | null;
  behindBytes: number;
  error: string | null;
  reads: number;
}

export interface LastRewrite {
  at?: number;
  ms?: number;
  error?: string;
  baseBytes?: number;
}

export interface ShardUp extends Place {
  i: number;
  ok: true;
  version: string | null;
  isolate: string;
  aliveSeconds: number;
  keys: number;
  memory: { used: number; max: number; wasm: number };
  clients: number;
  log: { base: number; size: number; rewriting: boolean; lastRewrite: LastRewrite | null };
  replicas: Replica[];
  reads: number;
  writes: number;
  restartedAt: number;
}

export interface ShardDown extends Place {
  i: number;
  ok: false;
  error: string;
  restartedAt: number;
  replicas: Replica[];
}

export type Shard = ShardUp | ShardDown;

export interface Entry extends Place {
  ops: number;
  conns: number;
}

export type TestLevel = "light" | "medium" | "heavy";

export interface TestView {
  level: TestLevel;
  from: string;
  since: number;
  until: number;
  senders: number;
}

export type Health = "healthy" | "restarting" | "unreachable" | "starting";

export interface Totals {
  reads: number;
  writes: number;
  replicaReads: number;
  keys: number;
  memory: number;
  maxMemory: number;
  logBytes: number;
  replicas: number;
  replicasReady: number;
  replicaLagMs: number;
}

// `writes`: whether writes were measured, which needs someone signed in watching.
export interface Probe {
  readMs: number | null;
  writeMs: number | null;
  writes: boolean;
  failed: number;
}

export interface LiveState {
  at: number;
  error: string | null;
  db: Database | null;
  watcher: Place | null;
  health: Health;
  restarting: number;
  totals: Totals;
  probe: Probe;
  shards: Shard[];
  map: { entries: Entry[] };
  test: TestView | null;
}

// `events` are the new or counted-up ones since the last tick.
export interface Tick {
  point: Point;
  events: LiveEvent[];
  state: LiveState;
}

export interface LiveSnapshot {
  history: Point[];
  events: LiveEvent[];
  state: LiveState | null;
}

export interface CommandResult {
  reply: TypedReply;
  ms: number;
  write: boolean;
  read: boolean;
  key: string | null;
  slot: number | null;
  shard: number | null;
  colo: string | null;
  replica: string | null;
  replication: { acked: number; of: number; ms: number } | null;
}
