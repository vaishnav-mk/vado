import type { Hint } from "../catalog/types";

export interface ReplicatorHost {
  readonly lastActive: number;
  readonly rewriting: Promise<void> | null;
  hold(bytes: number): void;
  release(bytes: number): void;
  execBatch(bytes: Uint8Array, count: number): Promise<Uint8Array>;
  readFile(path: string, pos: number, length: number): Uint8Array | null;
  fileSize(path: string): number | null;
}

export interface ReplicatorShard {
  name: string;
  replicas: ReplicaNamespace;
  dial: string;
  schedule(at: number): void;
}

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

export interface ReplicaStatus {
  region: Hint;
  state: "asleep" | "ready" | "catching up" | "idle" | "copying";
  lagMs: number | null;
  colo: string | null;
  behindBytes: number;
  error: string | null;
}

export interface Mark {
  at: number;
  ready?: boolean;
  onAck?: () => void;
}

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
