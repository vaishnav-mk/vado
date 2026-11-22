// What the dashboard is shown: /live (the Watcher) and Admin's replies. Types only, so the browser can import it.
import type { Flavour } from "../catalog/types";
import type { TypedReply } from "../protocol/types";

export type { TypedReply };

/** A Cloudflare location as a place. Fields are null when unknown. */
export interface Place {
  colo: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
}

/** A catalog record without its password hash (dbView). */
export interface Database {
  name: string;
  created: number;
  shards: number;
  regions: string[] | null;
  replicas: string[] | null;
  flavour: Flavour;
  password: boolean;
}

/** One poll, for the charts. `reads` includes what replicas served. */
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

/** A timeline entry. A repeat comes again with the same id, a later t and a higher count. */
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

/** Where clients connect: one Cloudflare location, its commands per second and open connections. */
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

/** Response time measured by the Watcher from its colo; `writes` says whether writes were measured (signed in). */
export interface Probe {
  readMs: number | null;
  writeMs: number | null;
  writes: boolean;
  failed: number;
}

/** Everything the page shows, as of `at`. */
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

/** The /live `tick` event: one poll. `events` are the new or counted-up ones since the last tick. */
export interface Tick {
  point: Point;
  events: LiveEvent[];
  state: LiveState;
}

/** The /live `snapshot` call: the whole picture, for a page that connects or resyncs. */
export interface LiveSnapshot {
  history: Point[];
  events: LiveEvent[];
  state: LiveState | null;
}

/** What Admin.command says about one command. */
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
