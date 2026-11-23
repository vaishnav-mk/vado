import type { DatabaseRecord } from "../catalog/types";
import type { CommandTable } from "../protocol/types";
import type { ValkeyShard } from "../shard/shard";

export type ShardStub = DurableObjectStub<ValkeyShard>;

export interface ClientSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export type Via = "tcp" | "ws" | "binding";

export interface Where {
  addr: string | null;
  colo?: string;
  city?: string;
  country?: string;
  lat?: number;
  lon?: number;
}

export type Callback = (frame: Uint8Array) => void;

export type UpKey = number | "pubsub" | `r${number}`;

export interface Upstream {
  readonly key: UpKey;
  dead: boolean;
  inflight: number;
  passthrough: Callback | null;
  send(bytes: Uint8Array, cb: Callback): void;
  raw(bytes: Uint8Array): void;
  check(now: number): void;
  idle(now: number, ms: number): boolean;
  close(): void;
}

export interface UpstreamOwner {
  readonly now: number;
  readonly dial: string;
  readonly proto: 2 | 3;
  stubOf(key: UpKey): ShardStub;
  setup(): Uint8Array[];
  wake(): void;
  push(frame: Uint8Array): void;
  lostConnection(up: Upstream): void;
  dropUpstream(up: Upstream): void;
  endPassthrough(lost: boolean): void;
  dropped(): Uint8Array;
}

export interface ReplyOwner {
  wake(): void;
  close(): void;
  dropped(): Uint8Array;
}

export interface DatabaseHandles {
  db: DatabaseRecord;
  table: CommandTable;
  shard(i: number): ShardStub;
  pubsub(): ShardStub;
  replica(i: number): ShardStub | null;
}

export interface SignIns {
  blocked(): boolean;
  failed(): void;
}

export interface RouterOptions {
  password: string | undefined;
  // A service binding: the shared password opens any database.
  trusted: boolean;
  // Never creates a database.
  lookup(name: string): Promise<DatabaseRecord | null>;
  open(name: string): Promise<DatabaseHandles>;
  onDropped(name: string): void;
  signIns: SignIns | null;
  idleMs: number;
  dial: string;
}

export interface Multi {
  cmds: Uint8Array[];
  shard: number | null;
  watched: boolean;
  failed: boolean;
}

export interface RouterView {
  readonly commands: number;
  readonly db: DatabaseRecord;
}
