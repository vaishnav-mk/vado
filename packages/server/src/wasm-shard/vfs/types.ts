export type VfsStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

export type Memory = () => WebAssembly.Memory;

export interface Views {
  u8: () => Uint8Array;
  dv: () => DataView;
}

export interface ChunkRow {
  seq: number;
  start: number;
  len: number;
}

export interface Chunk {
  seq: number;
  data: Uint8Array;
}

// Open fds share this object, so every fd sees a rename or unlink.
export interface FileNode {
  path: string;
  key: string;
  size: number;
  nextSeq: number;
  pending: Uint8Array[];
  pendingLen: number;
  rows: ChunkRow[] | null;
  cache: Chunk | null;
  // undefined: not looked up yet; null: the last row is full (or there is none)
  tail: Chunk | null | undefined;
}

export interface OpenFile {
  dir: false;
  node: FileNode;
  pos: number;
  append: boolean;
}

export interface OpenDir {
  dir: true;
  path: string;
}

export type OpenFd = OpenFile | OpenDir;

// Field names are part of the stats RPC result.
export interface FileEntry {
  path: string;
  is_dir: number;
  size: number;
  rows: number;
}

export interface VfsStats {
  writes: number;
  writeBytes: number;
  reads: number;
  readBytes: number;
  rowsWritten: number;
}
