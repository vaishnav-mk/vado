import type { VfsStats } from "../vfs/types";

export type TagConstructor = new (type: { parameters: string[] }) => WebAssembly.ImportValue;

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
  sync?: () => Promise<void>;
  fatal?: (error: Error) => void;
}

export type RewriteJob = () => Promise<boolean>;

export type RewriteHook = (tmp: string, rdb: boolean) => RewriteJob | null;

export type Protocol = 2 | 3;

export interface SocketWriter {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export type ByteSocket = Pick<Socket, "readable" | "writable">;

export interface HostSocket {
  fd: number;
  chunks: Uint8Array[];
  off: number; // read offset into chunks[0]
  eof: boolean;
  writer: SocketWriter;
  internal: boolean;
  inflight: number; // reply bytes written but not yet acknowledged
  wake: (() => void) | null;
  closed: PromiseWithResolvers<void>; // Valkey closed the fd
  finished: PromiseWithResolvers<void>; // serve() closed the socket
}

export interface PooledClient {
  alive: boolean;
  socket: HostSocket;
  out: Uint8Array;
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
  sockets: number;
  pooled: number;
  cronRunning: boolean;
  vfs: VfsStats;
}

export interface RewriteState {
  onRewrite: RewriteHook | null;
  rewriting: Promise<void> | null;
  rewriteDoneMs: number | null;
}

export interface InputSink {
  lastActive: number;
  onInput: (() => void) | null;
}

export interface RewriteDeps {
  state: RewriteState;
  text: (ptr: number, len: number) => string;
  finish: (ok: boolean, generation: number) => boolean;
  remove: (path: string) => void;
  sync: (() => Promise<void>) | undefined;
  log: (line: string) => void;
  schedule: () => void;
}

export interface SocketEvents {
  schedule(): void;
  closed(): void;
}
