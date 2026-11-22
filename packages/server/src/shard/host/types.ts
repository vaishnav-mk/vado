import type { VfsStats } from "../vfs/types";

export type TagConstructor = new (type: { parameters: string[] }) => WebAssembly.ImportValue;

/** The exports of valkey.wasm and redis.wasm that the host calls (packages/wasm/{valkey,redis}/interface.txt). */
export type ValkeyExports = {
  memory: WebAssembly.Memory;
  _initialize: () => void;
  rk_args_cap: () => number;
  rk_args_ptr: () => number;
  rk_boot_args: (len: number) => number;
  rk_next_timeout_ms: () => number;
  rk_rewrite_done: (ok: number, generation: number) => number;
  rk_tick: () => void;
};

export interface HostOptions {
  args?: string[];
  log?: (line: string) => void;
  sync?: () => Promise<void>; // resolves once every storage write so far is confirmed
  fatal?: (error: Error) => void; // Valkey threw mid-command
}

/** Writes the base of an AOF rewrite Valkey just started; resolves whether it did. */
export type RewriteJob = () => Promise<boolean>;

/** Takes a rewrite into `tmp`, or returns null so Valkey rewrites inline, blocking. */
export type RewriteHook = (tmp: string, rdb: boolean) => RewriteJob | null;

export type Protocol = 2 | 3;

export interface SocketWriter {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export type ByteSocket = Pick<Socket, "readable" | "writable">;

/** A Valkey client fd: a socket, or an internal client for RPC batches. */
export interface HostSocket {
  fd: number;
  chunks: Uint8Array[]; // input Valkey hasn't read
  off: number; // read offset into chunks[0]
  eof: boolean;
  writer: SocketWriter;
  internal: boolean;
  inflight: number; // reply bytes written but not yet acknowledged
  wake: (() => void) | null; // resumes a reader paused by backpressure
  closed: PromiseWithResolvers<void>; // Valkey closed the fd
  finished: PromiseWithResolvers<void>; // serve() closed the socket
}

export interface PooledClient {
  alive: boolean;
  socket: HostSocket;
  out: Uint8Array; // reply bytes: the first `len` are used, the rest is room to grow
  len: number;
  pos: number; // end of the last complete reply
  frames: number;
  want: number;
  resume: { k: number; rel: number }; // frameEnd's progress through an aggregate that arrives in pieces
}

export interface DrainReport {
  clients: number;
  closed: boolean;
}

export interface HostStats {
  wasmMemoryBytes: number;
  sockets: number; // client connections (routers, direct)
  pooled: number; // idle internal clients kept for RPC batches
  cronRunning: boolean;
  vfs: VfsStats;
}

/** What the aof_rewrite import reads and sets on the host. */
export interface RewriteState {
  onRewrite: RewriteHook | null;
  rewriting: Promise<void> | null;
  rewriteDoneMs: number | null;
}

/** What serve() reports client input to. */
export interface InputSink {
  lastActive: number;
  onInput: (() => void) | null;
}

export interface RewriteDeps {
  state: RewriteState;
  text: (ptr: number, len: number) => string;
  // rk_rewrite_done: Valkey renames tmp into place and swaps the manifest, as when a forked child exits
  finish: (ok: boolean, generation: number) => boolean;
  remove: (path: string) => void;
  sync: (() => Promise<void>) | undefined;
  log: (line: string) => void;
  schedule: () => void;
}

/** What the socket imports tell the loop. */
export interface SocketEvents {
  schedule(): void; // a socket failed: Valkey should see it
  closed(): void; // Valkey closed a socket
}
