import type { Generation } from "./store";

export interface Started {
  exited: Promise<void>;
  reused: boolean; // it was already running: the same server, with its memory
  history: { replid: string; offset: number } | null; // a restored server's own, after the stored copy
  restored: { baseMB: number; logMB: number; copyMs: number; loadMs: number; replayMs: number } | null;
}

// Where a stored stream can go on: the history to ask for and the offset of its last stored byte.
export interface Resume {
  from: Generation;
  replid: string;
  offset: number;
  only: boolean; // a full copy from this server isn't trusted: a refusal fails the link
}

// Resolves once the replication stream up to an offset is stored, whichever link is current by then.
export type Fence = (offset: number) => Promise<void>;

export interface Waiter {
  offset: number;
  resolve: () => void;
  reject: (e: Error) => void;
}

// A client batch in flight through the proxy.
export interface ProxyBatch {
  count: number;
  fenced: boolean; // ROLE follows the batch
  raw: boolean; // a subscribe: from here on, replies pass through as they come
}

// An RPC batch waiting on the shared connection.
export interface MuxBatch {
  count: number;
  frames: Uint8Array[];
  resolve: (replies: Uint8Array) => void;
  reject: (e: Error) => void;
}
