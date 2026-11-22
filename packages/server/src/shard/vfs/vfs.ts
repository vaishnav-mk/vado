// A WASI preview1 filesystem on Durable Object SQLite, for Valkey's AOF and RDB files. Every call is synchronous,
// like the wasm that makes it. Writes to O_APPEND fds (the AOF) are stored at once, so the output gate holds a
// reply until the AOF bytes behind it are durable; other files buffer until fsync or close.
import { migrate } from "../../migrate";
import { addMissingColumns } from "./legacy";
import { vfsMigrations } from "./migrations";
import { concat } from "../../protocol/resp";
import { viewsOf } from "./memory";
import { isDeleted, Store } from "./store";
import type { FileEntry, Memory, VfsStats, VfsStorage, Views } from "./types";
import { E, FdTable } from "./wasi-abi";
import { fdImports } from "./wasi-fds";
import { parentOf, pathImports } from "./wasi-paths";

const noMemory = (): WebAssembly.Memory => {
  throw new Error("this Vfs runs no wasm");
};

export class Vfs {
  readonly stats: VfsStats = { writes: 0, writeBytes: 0, reads: 0, readBytes: 0, rowsWritten: 0 };
  onAppend: ((bytes: Uint8Array) => void) | null = null; // each append to the AOF's incr file: the replication stream
  onTrash: (() => void) | null = null; // there are deleted files' chunks for sweep()
  readonly #store: Store;
  readonly #fds = new FdTable();
  readonly #views: Views;

  constructor(storage: VfsStorage, memory: Memory = noMemory) {
    migrate(storage, vfsMigrations, addMissingColumns);
    this.#store = new Store(storage, this.stats, () => this.onTrash?.());
    this.#views = viewsOf(memory);
  }

  /** The file WASI imports; the host adds stdio, the clock and fd_write (which calls write()). */
  imports() {
    return { ...fdImports(this.#fds, this.#store, this.#views), ...pathImports(this.#fds, this.#store, this.#views) };
  }

  /** fd_write for Vfs fds: a WASI errno, or null if `fd` isn't one (stdio). */
  write(fd: number, chunks: Uint8Array[]): number | null {
    const f = this.#fds.get(fd);

    if (!f) return null;

    if (f.dir) return E.BADF;
    const n = f.node;

    if (isDeleted(n)) return E.OK; // writes to an unlinked-but-open file vanish
    let total = 0;

    for (const c of chunks) total += c.length;
    const pos = f.append ? n.size : f.pos;

    if (pos !== n.size) {
      // An overwrite in the middle, which Valkey's AOF and RDB never do: rewrite the file.
      const all = new Uint8Array(Math.max(n.size, pos + total));
      this.#store.readAt(n, 0, all.subarray(0, n.size));
      all.set(concat(chunks), pos);
      this.#store.rewrite(n, all);
    } else {
      const bytes = chunks.length === 1 ? chunks[0].slice() : concat(chunks);
      this.#store.append(n, bytes, f.append); // the AOF: stored before Valkey's reply goes out

      // The incr file is only ever appended to; Valkey opens it without O_APPEND under WASI.
      if (this.onAppend && n.path.endsWith(".incr.aof")) this.onAppend(bytes);
    }

    f.pos = pos + total;

    return E.OK;
  }

  /** Bytes [pos, pos + len) of the file at `path` (relative to the root), or null if it doesn't exist. */
  read(path: string, pos: number, len: number): Uint8Array | null {
    const n = this.#store.node(path);

    if (!n) return null;
    const dst = new Uint8Array(Math.max(0, Math.min(len, n.size - pos)));
    this.#store.readAt(n, pos, dst);

    return dst;
  }

  size(path: string): number | null {
    return this.#store.node(path)?.size ?? null;
  }

  /** Deletes about `bytes` of deleted files' chunks (at least one row). Returns whether any are left. */
  sweep(bytes: number): boolean {
    return this.#store.sweep(bytes);
  }

  /** Deletes every file and directory. */
  clear(): void {
    this.#store.clear();
  }

  /** Appends to the file at `path`, creating it (and its directory) if missing. Buffered until flush(). */
  append(path: string, bytes: Uint8Array): void {
    let n = this.#store.node(path);

    if (!n) {
      const dir = parentOf(path);

      if (dir && !this.#store.row(dir)) this.#store.mkdir(dir);
      n = this.#store.create(path);
    }

    this.#store.append(n, bytes.slice(), false);
  }

  flush(): void {
    for (const n of this.#store.nodes()) this.#store.flush(n);
  }

  remove(path: string): void {
    if (this.#store.row(path)) this.#store.unlink(path);
  }

  listing(): FileEntry[] {
    return this.#store.listing();
  }
}
