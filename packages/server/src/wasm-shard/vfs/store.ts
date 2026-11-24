import { concat } from "../../protocol/resp";
import { growLastRow, indexRows, pushRow, rowAt } from "./chunks";
import { VFS_CHUNK, VFS_TAIL } from "./config";
import { Listing } from "./listing";
import { prepareStatements, type Statements } from "./statements";
import type { Chunk, FileEntry, FileNode, VfsStats, VfsStorage } from "./types";

const DELETED = "\0deleted:";

export const isDeleted = (n: FileNode) => n.path.startsWith(DELETED);

export class Store {
  readonly #q: Statements;
  readonly #stats: VfsStats;
  readonly #trashed: () => void;
  readonly #nodes = new Map<string, FileNode>();
  readonly #listing: Listing;

  constructor(storage: VfsStorage, stats: VfsStats, trashed: () => void) {
    this.#stats = stats;
    this.#trashed = trashed;
    this.#q = prepareStatements(storage, stats);
    this.#listing = new Listing(this.#q);
  }

  row(path: string) {
    return this.#q.node.get({ path });
  }

  cached(path: string): FileNode | undefined {
    return this.#nodes.get(path);
  }

  node(path: string): FileNode | null {
    const cached = this.#nodes.get(path);

    if (cached) return cached;
    const row = this.row(path);

    if (!row || row.isDir) return null;
    const last = this.#q.lastSeq.get({ key: row.key })?.seq ?? -1;

    return this.#cache(path, row.key, row.size, last + 1, undefined);
  }

  create(path: string): FileNode {
    const key = `#${crypto.randomUUID()}`;
    this.#q.insertFile.run({ path, key });
    this.#listing.reset();

    return this.#cache(path, key, 0, 0, null);
  }

  #cache(path: string, key: string, size: number, nextSeq: number, tail: null | undefined): FileNode {
    const n: FileNode = { path, key, size, nextSeq, pending: [], pendingLen: 0, rows: null, cache: null, tail };
    this.#nodes.set(path, n);

    return n;
  }

  nodes(): IterableIterator<FileNode> {
    return this.#nodes.values();
  }

  // The node now owns `bytes`.
  append(n: FileNode, bytes: Uint8Array, writeThrough: boolean): void {
    n.pending.push(bytes);
    n.pendingLen += bytes.length;
    n.size += bytes.length;

    if (writeThrough || n.pendingLen >= VFS_CHUNK) this.flush(n);
  }

  flush(n: FileNode): void {
    if (!n.pendingLen) return;

    if (n.tail === undefined) n.tail = this.#lastTail(n.key);
    const tail = n.tail;

    if (tail && tail.data.length + n.pendingLen <= VFS_TAIL) {
      const data = concat([tail.data, ...n.pending]);
      this.#q.updateChunk.run({ data, key: n.key, seq: tail.seq });
      tail.data = data;

      if (n.rows && !growLastRow(n.rows, tail.seq, data.length)) n.rows = null;

      if (n.cache?.seq === tail.seq) n.cache = tail;
      this.#listing.grew(n.key, n.pendingLen, 0);
    } else {
      const all = n.pending.length === 1 ? n.pending[0] : concat(n.pending);

      for (let i = 0; i < all.length; i += VFS_CHUNK) {
        const part = all.subarray(i, i + VFS_CHUNK);
        const seq = n.nextSeq++;
        this.#q.insertChunk.run({ key: n.key, seq, data: part });
        n.tail = part.length < VFS_TAIL ? { seq, data: part.slice() } : null;

        if (n.rows) pushRow(n.rows, seq, part.length);
        this.#listing.grew(n.key, part.length, 1);
      }
    }

    this.#stats.writes++;
    this.#stats.writeBytes += n.pendingLen;
    n.pending.length = 0;
    n.pendingLen = 0;
  }

  #lastTail(key: string): Chunk | null {
    const last = this.#q.lastChunk.get({ key });

    return last && last.data.length < VFS_TAIL ? last : null;
  }

  readAt(n: FileNode, pos: number, dst: Uint8Array): number {
    const rows = this.#rows(n);
    let done = 0;

    for (let i = rowAt(rows, pos); i >= 0 && i < rows.length && done < dst.length; i++) {
      const r = rows[i];
      const from = pos + done - r.start;

      if (from < 0 || from >= r.len) continue;

      if (n.cache?.seq !== r.seq) {
        const chunk = this.#q.readChunk.get({ key: n.key, seq: r.seq });

        if (!chunk) throw new Error(`vfs: chunk ${r.seq} of ${n.path} is missing`);
        n.cache = { seq: r.seq, data: chunk.data };
      }

      const take = Math.min(r.len - from, dst.length - done);
      dst.set(n.cache.data.subarray(from, from + take), done);
      done += take;
    }

    this.#stats.reads++;
    this.#stats.readBytes += done;

    return done;
  }

  #rows(n: FileNode) {
    this.flush(n);
    n.rows ??= indexRows(this.#q.chunkRows.all({ key: n.key }));

    return n.rows;
  }

  rewrite(n: FileNode, bytes: Uint8Array): void {
    this.#q.deleteChunks.run({ key: n.key });
    Object.assign(n, { nextSeq: 0, size: 0, pendingLen: 0, rows: null, cache: null, tail: null });
    n.pending.length = 0;
    this.#listing.reset();
    this.append(n, bytes, true);
  }

  truncate(n: FileNode, size: number): void {
    if (isDeleted(n)) return; // an unlinked-but-open file: its rows are gone
    this.flush(n);

    if (size > n.size) this.append(n, new Uint8Array(size - n.size), true);
    else if (size < n.size) {
      const keep = new Uint8Array(size);
      this.readAt(n, 0, keep);
      this.rewrite(n, keep);
    }
  }

  mkdir(path: string): void {
    this.#q.insertDir.run({ path });
    this.#listing.reset();
  }

  unlink(path: string): void {
    const n = this.#nodes.get(path);
    const key = n ? n.key : this.row(path)?.key;

    if (n) {
      n.pending.length = 0;
      n.pendingLen = 0;
      this.#nodes.delete(path);
      n.path = DELETED + path;
    }

    // A key is never reused (new files get a fresh one), so its chunks can go later.
    if (key !== undefined) {
      this.#q.trash.run({ key });
      this.#trashed();
    }

    this.#q.deleteNode.run({ path });
    this.#listing.reset();
  }

  rename(from: string, to: string): void {
    const n = this.#nodes.get(from);

    if (n) this.flush(n);
    this.unlink(to);
    this.#q.renameNode.run({ to, path: from });

    if (n) {
      this.#nodes.delete(from);
      n.path = to;
      this.#nodes.set(to, n);
    }
  }

  children(prefix: string) {
    return this.#q.children.all({ pattern: prefix + "%" }).filter((r) => !r.path.slice(prefix.length).includes("/"));
  }

  sweep(bytes: number): boolean {
    const trash = this.#q.firstTrash.get();

    if (!trash) return false;
    let from: number | null = null;
    let sum = 0;

    for (const r of this.#q.trashRows.all({ key: trash.key })) {
      from = r.seq;

      if ((sum += r.len) >= bytes) break;
    }

    if (from === null) this.#q.untrash.run({ key: trash.key });
    else this.#q.deleteChunksFrom.run({ key: trash.key, seq: from });

    return true;
  }

  clear(): void {
    for (const statement of this.#q.clear) statement.run();
    this.#nodes.clear();
    this.#listing.reset();
  }

  listing(): FileEntry[] {
    return this.#listing.entries();
  }
}
