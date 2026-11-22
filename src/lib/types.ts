// The shapes the backend sends: /live messages (src/admin/watcher.js, src/admin/views.js) and the Admin
// entrypoint's replies (src/admin/admin.js). Every field the page reads may be missing in an older or
// half-built message, so components read them with `?.` and `??`.

/** A Cloudflare location as a place. Fields are null when unknown. */
export interface Place {
  colo: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
}

/** A catalog record without secrets (dbView). */
export interface Database {
  name: string;
  created: number;
  shards: number;
  regions: string[] | null;
  replicas: string[] | null;
  password: boolean;
  flavour?: "valkey" | "redis"; // missing from a database Worker older than flavours: Valkey
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

export interface ShardUp extends Place {
  i: number;
  ok: true;
  version: string | null;
  aliveSeconds: number;
  keys: number;
  memory: { used: number; max: number; wasm: number };
  clients: number;
  log: { base: number; size: number; rewriting: boolean; lastRewrite: { at?: number; ms?: number; error?: string; baseBytes?: number } | null };
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

export interface TestView {
  level: "light" | "medium" | "heavy";
  from: string;
  since: number;
  until: number;
  senders: number;
}

export type Health = "healthy" | "restarting" | "unreachable" | "starting";

export interface LiveState {
  at: number;
  error: string | null;
  db: Database | null;
  watcher: Place | null;
  health: Health;
  restarting: number;
  totals: {
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
  };
  probe: { readMs: number | null; writeMs: number | null; writes?: boolean; failed: number }; // writes: measured (signed in)
  shards: Shard[];
  map: { entries: Entry[] };
  test: TestView | null;
}

export type LiveMessage =
  | { type: "init"; history: Point[]; events: LiveEvent[]; state: LiveState | null }
  | { type: "tick"; point: Point; events: LiveEvent[]; state: LiveState };

/** A decoded RESP reply: bulk and simple strings as strings, errors as { err }. */
export type Reply = string | number | boolean | null | { err: string } | Reply[];

/** What Admin.command says about one command. */
export interface CommandResult {
  reply: Reply;
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

/** The last command run from this page, as the dial and the globe show it. */
export interface LastCommand extends CommandResult {
  at: number;
  argv: string[];
  /** The states of the key's shard's replicas when the command was sent, if the page knew them. */
  before: ReplicaState[] | null;
}
