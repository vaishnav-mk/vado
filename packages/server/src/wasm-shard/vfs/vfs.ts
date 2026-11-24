import { migrate } from "../../migrate";
import { vfsLegacy, vfsMigrations } from "./migrations";
import { concat } from "../../protocol/resp";
import { viewsOf } from "./memory";
import { isDeleted, VfsStore } from "./store";
import type { FileEntry, VfsStats, VfsStorage, Views } from "./types";
import { E, FdTable } from "./wasi-abi";
import { fdImports } from "./wasi-fds";
import { parentOf, pathImports } from "./wasi-paths";

const noMemory = (): WebAssembly.Memory => {
  throw new Error("this Vfs runs no wasm");
};

export class Vfs {
  readonly stats: VfsStats = { writes: 0, writeBytes: 0, reads: 0, readBytes: 0, rowsWritten: 0 };
  onAppend: ((bytes: Uint8Array) => void) | null = null;
  onTrash: (() => void) | null = null;
  readonly #store: VfsStore;
  readonly #fds = new FdTable();
  readonly #views: Views;

  constructor(storage: VfsStorage, views: Views = viewsOf(noMemory)) {
    migrate(storage, vfsMigrations, vfsLegacy);
    this.#store = new VfsStore(storage, this.stats, () => this.onTrash?.());
    this.#views = views;
  }

  imports() {
    return { ...fdImports(this.#fds, this.#store, this.#views), ...pathImports(this.#fds, this.#store, this.#views) };
  }

  // null: `fd` is stdio.
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
      // Valkey's AOF and RDB never overwrite, so this needn't be cheap.
      const all = new Uint8Array(Math.max(n.size, pos + total));
      this.#store.readAt(n, 0, all.subarray(0, n.size));
      all.set(concat(chunks), pos);
      this.#store.rewrite(n, all);
    } else {
      const bytes = chunks.length === 1 ? chunks[0].slice() : concat(chunks);
      this.#store.append(n, bytes, f.append);

      // The incr file is only ever appended to; Valkey opens it without O_APPEND under WASI.
      if (this.onAppend && n.path.endsWith(".incr.aof")) this.onAppend(bytes);
    }

    f.pos = pos + total;

    return E.OK;
  }

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

  sweep(bytes: number): boolean {
    return this.#store.sweep(bytes);
  }

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
