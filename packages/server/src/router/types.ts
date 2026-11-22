import type { DatabaseRecord } from "../catalog/types";
import type { CommandTable } from "../protocol/types";
import type { ValkeyShard } from "../shard/shard";

export type ShardStub = DurableObjectStub<ValkeyShard>;

export interface ClientSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export type Via = "tcp" | "ws" | "binding";

/** What's known of where a client connects from. */
export interface Where {
  addr: string | null;
  colo?: string;
  city?: string;
  country?: string;
  lat?: number;
  lon?: number;
}

export type Callback = (frame: Uint8Array) => void;

/** A shard's primary (its index), the database's pub/sub object, or a nearby replica of shard i ("r<i>"). */
export type UpKey = number | "pubsub" | `r${number}`;

/** One shard connection: a socket, or RPC batches when the isolate is out of sockets. */
export interface Upstream {
  readonly key: UpKey;
  dead: boolean;
  /** Bytes sent and not yet acknowledged. */
  inflight: number;
  /** RESP2 pub/sub: every frame goes here once nothing is owed. */
  passthrough: Callback | null;
  send(bytes: Uint8Array, cb: Callback): void;
  /** Bytes whose replies aren't matched to callbacks (RESP3 subscribes, passthrough). */
  raw(bytes: Uint8Array): void;
  check(now: number): void;
  idle(now: number, ms: number): boolean;
  close(): void;
}

/** What an upstream asks of the connection it serves. */
export interface UpstreamOwner {
  readonly now: number;
  readonly dial: string;
  readonly proto: 2 | 3;
  stubOf(key: UpKey): ShardStub;
  /** What a new shard socket is sent first, so it serves this connection as the last one did. */
  setup(): Uint8Array[];
  wake(): void;
  push(frame: Uint8Array): void;
  lostConnection(up: Upstream): void;
  dropUpstream(up: Upstream): void;
  endPassthrough(lost: boolean): void;
  dropped(): Uint8Array;
}

/** What the reply queue asks of its connection. */
export interface ReplyOwner {
  wake(): void;
  close(): void;
  dropped(): Uint8Array;
}

/** A database and the objects that hold it, as one connection sees them. */
export interface DatabaseHandles {
  db: DatabaseRecord;
  table: CommandTable;
  shard(i: number): ShardStub;
  pubsub(): ShardStub;
  /** A nearby replica of shard i, or null. */
  replica(i: number): ShardStub | null;
}

/** Failed AUTHs from one client address. */
export interface SignIns {
  blocked(): boolean;
  failed(): void;
}

export interface RouterOptions {
  /** Undefined: no AUTH required. */
  password: string | undefined;
  /** A service binding (our own Workers): the shared password opens any database. */
  trusted: boolean;
  /** A database's record, or null; never creates one. */
  lookup(name: string): Promise<DatabaseRecord | null>;
  open(name: string): Promise<DatabaseHandles>;
  /** Forget the cached record of a database found dropped. */
  onDropped(name: string): void;
  signIns: SignIns | null;
  idleMs: number;
  /** What shard sockets dial: "router-<deploy ms>:6379". */
  dial: string;
}

/** A transaction being queued: sent to one shard at EXEC. */
export interface Multi {
  cmds: Uint8Array[];
  shard: number | null;
  watched: boolean;
  failed: boolean;
}

/** What a Pulse report reads of a router. */
export interface RouterView {
  readonly commands: number;
  readonly db: DatabaseRecord;
}
