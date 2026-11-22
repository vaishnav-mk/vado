import type { Hint } from "../catalog/types";

/** What the Replicator needs from its shard's ValkeyHost. */
export interface ReplicatorHost {
  /** Date.now() of the last client activity. */
  readonly lastActive: number;
  /** While an AOF rewrite runs. */
  readonly rewriting: Promise<void> | null;
  /** Bytes held for replicas count toward the host's high-water mark until released. */
  hold(bytes: number): void;
  release(bytes: number): void;
  execBatch(bytes: Uint8Array, count: number): Promise<Uint8Array>;
  readFile(path: string, pos: number, length: number): Uint8Array | null;
  fileSize(path: string): number | null;
}

/** What the Replicator needs from its shard besides the host. */
export interface ReplicatorShard {
  /** The primary's object name; its replicas are named from it (replicaName). */
  name: string;
  /** The class its replicas live in (replicaBinding). */
  replicas: ReplicaNamespace;
  /** The address to dial on a replica (replicaDial). */
  dial: string;
  /** Runs tick() at `at` (ms), replacing any earlier request. */
  schedule(at: number): void;
}

/** The replica and primary RPC methods of ValkeyShard, as callers see them. */
export interface ShardRpc {
  replicate(regions: Hint[]): void | Promise<void>;
  waitReplicas(n: number, ms: number): number | Promise<number>;
  /** The colo it runs in. */
  replicaReady(): (string | null) | Promise<string | null>;
  replicaIdleMs(): number | Promise<number>;
  retire(): void | Promise<void>;
}

/** A replica's stub, as its primary uses it. */
export interface ReplicaStub {
  connect(address: string): Socket;
  replicaReady(): Promise<string | null>;
  replicaIdleMs(): Promise<number>;
  retire(): Promise<void>;
}

export interface ReplicaNamespace {
  getByName(name: string, options: { locationHint: Hint }): ReplicaStub;
}

export type ReplicaPhase = "idle" | "copying" | "live";

/** One replica as stats().replicas reports it. */
export interface ReplicaStatus {
  region: Hint;
  state: "asleep" | "ready" | "catching up" | "idle" | "copying";
  lagMs: number | null;
  colo: string | null;
  behindBytes: number;
  error: string | null;
}

/** A marker sent to a replica: answered by one "+PONG". */
export interface Mark {
  at: number;
  /** The first marker after a copy: once answered, the replica serves reads. */
  ready?: boolean;
  onAck?: () => void;
}

/** An AOF manifest line naming a file. */
export interface AofEntry {
  path: string;
  type: string;
  line: string;
}

export interface AofFiles {
  base: string | undefined;
  incrs: string[];
  entries: AofEntry[];
}
