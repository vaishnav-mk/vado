// A WASI preview1 filesystem backed by Durable Object SQLite, for Valkey's AOF and RDB files.
// Every call is synchronous, like the wasm that makes it. Files are rows of at most VFS_CHUNK bytes.
// Writes to O_APPEND fds (the AOF) are written through at once, so the output gate holds a
// reply until the AOF bytes behind it are durable. Other files buffer until fsync or close.
// Rows written are billed, so a small last row grows in place: one row per AOF append, and a
// rewrite deletes one row per VFS_TAIL bytes instead of one per append. File sizes are derived from
// the chunks, never stored separately. A file's chunks are stored under its key (vfs_node.chunks, or
// its path for files made before keys existed), so a rename moves one row, not the whole file.

import { VFS_CHUNK, VFS_TAIL } from "./constants.js";

const PREOPEN_FD = 3;
const PREOPEN_NAME = "/data";

// WASI errnos and file types.
const E = { OK: 0, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55 };
const FT = { CHAR: 2, DIR: 3, FILE: 4 };
const O = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const FD_APPEND = 1;

const concatBytes = (chunks, total) => { const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; };

export class Vfs {
  #sql;
  #mem;
  #fds = new Map(); // fd -> { node, pos, append, dir }
  #nodes = new Map(); // path -> { path, size, nextSeq, pending: Uint8Array[], pendingLen, rows?, cache? }
  #nextFd = PREOPEN_FD + 1;
  #dec = new TextDecoder();
  stats = { writes: 0, writeBytes: 0, reads: 0, readBytes: 0, rowsWritten: 0 };
  onAppend = null; // (bytes) => void, for each append to the AOF's incr file: the replication stream

  constructor(sql, memory) {
    this.#sql = sql;
    this.#mem = memory; // () => WebAssembly.Memory
    sql.exec(`CREATE TABLE IF NOT EXISTS vfs_node (path TEXT PRIMARY KEY, is_dir INTEGER NOT NULL, size INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS vfs_chunk (path TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, seq)) WITHOUT ROWID`);
    // Added later: the key a file's chunks are stored under (vfs_chunk.path); NULL = the file's own path.
    if (!sql.exec(`PRAGMA table_info(vfs_node)`).toArray().some((c) => c.name === "chunks")) sql.exec(`ALTER TABLE vfs_node ADD COLUMN chunks TEXT`);
    // Keys of deleted files whose chunks sweep() hasn't removed yet. Freeing a big file's pages in one
    // commit is slow (SQLite moves the pages after them down), so an unlink only drops the node.
    sql.exec(`CREATE TABLE IF NOT EXISTS vfs_trash (key TEXT PRIMARY KEY)`);
  }
  onTrash = null; // () => void: there are chunks for sweep() to delete

  // ---- helpers ----
  #u8v = null; #dvv = null; // rebuilt only when wasm memory grows
  #u8() { const b = this.#mem().buffer; return this.#u8v?.buffer === b ? this.#u8v : (this.#u8v = new Uint8Array(b)); }
  #dv() { const b = this.#mem().buffer; return this.#dvv?.buffer === b ? this.#dvv : (this.#dvv = new DataView(b)); }
  #str(ptr, len) { return this.#dec.decode(this.#u8().subarray(ptr, ptr + len)); }

  // Resolve `path` relative to directory fd `dirfd` into a key under the preopen root ("" is the root).
  #resolve(dirfd, ptr, len) {
    let base;
    if (dirfd === PREOPEN_FD) base = "";
    else {
      const f = this.#fds.get(dirfd);
      if (!f?.dir) return null;
      base = f.node.path;
    }
    const parts = base ? base.split("/") : [];
    for (const p of this.#str(ptr, len).split("/")) {
      if (p === "" || p === ".") continue;
      if (p === "..") parts.pop();
      else parts.push(p);
    }
    return parts.join("/");
  }

  #row(path) {
    return this.#sql.exec(`SELECT is_dir, coalesce(chunks, path) AS key, coalesce((SELECT sum(length(data)) FROM vfs_chunk WHERE vfs_chunk.path = coalesce(n.chunks, n.path)), 0) AS size FROM vfs_node n WHERE path = ?`, path).toArray()[0];
  }

  // Every write statement goes through here so rowsWritten counts what is billed.
  #write(query, ...args) {
    this.stats.rowsWritten += this.#sql.exec(query, ...args).rowsWritten;
  }

  #node(path) {
    let n = this.#nodes.get(path);
    if (n) return n;
    const row = this.#row(path);
    if (!row || row.is_dir) return null;
    const seq = this.#sql.exec(`SELECT coalesce(max(seq), -1) AS s FROM vfs_chunk WHERE path = ?`, row.key).one().s;
    n = { path, key: row.key, size: row.size, nextSeq: seq + 1, pending: [], pendingLen: 0, rows: null, cache: null, tail: undefined };
    this.#nodes.set(path, n);
    return n;
  }

  #flush(n) {
    if (!n.pendingLen) return;
    const all = new Uint8Array(n.pendingLen);
    let o = 0;
    for (const p of n.pending) { all.set(p, o); o += p.length; }
    if (n.tail === undefined) {
      const last = this.#sql.exec(`SELECT seq, data FROM vfs_chunk WHERE path = ? ORDER BY seq DESC LIMIT 1`, n.key).toArray()[0];
      n.tail = last && last.data.byteLength < VFS_TAIL ? { seq: last.seq, data: new Uint8Array(last.data) } : null;
    }
    let i = 0;
    if (n.tail && n.tail.data.length + all.length <= VFS_TAIL) {
      const data = new Uint8Array(n.tail.data.length + all.length);
      data.set(n.tail.data);
      data.set(all, n.tail.data.length);
      this.#write(`UPDATE vfs_chunk SET data = ? WHERE path = ? AND seq = ?`, data, n.key, n.tail.seq);
      n.tail.data = data;
      i = all.length;
    }
    for (; i < all.length; i += VFS_CHUNK) {
      const part = all.subarray(i, i + VFS_CHUNK), seq = n.nextSeq++;
      this.#write(`INSERT INTO vfs_chunk (path, seq, data) VALUES (?, ?, ?)`, n.key, seq, part);
      n.tail = part.length < VFS_TAIL ? { seq, data: part.slice() } : null;
    }
    this.stats.writes++;
    this.stats.writeBytes += all.length;
    n.pending = [];
    n.pendingLen = 0;
    n.rows = null;
    n.cache = null;
  }

  // Row index for reads: [{ seq, start, len }], built lazily, dropped on write.
  #rows(n) {
    if (n.rows) return n.rows;
    this.#flush(n);
    let start = 0;
    n.rows = this.#sql.exec(`SELECT seq, length(data) AS len FROM vfs_chunk WHERE path = ? ORDER BY seq`, n.key).toArray()
      .map((r) => { const e = { seq: r.seq, start, len: r.len }; start += r.len; return e; });
    return n.rows;
  }

  #readAt(n, pos, dst) {
    const rows = this.#rows(n);
    let lo = 0, hi = rows.length - 1, i = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (rows[m].start <= pos) { i = m; lo = m + 1; } else hi = m - 1; }
    let done = 0;
    for (; i >= 0 && i < rows.length && done < dst.length; i++) {
      const r = rows[i];
      if (n.cache?.seq !== r.seq) {
        n.cache = { seq: r.seq, data: new Uint8Array(this.#sql.exec(`SELECT data FROM vfs_chunk WHERE path = ? AND seq = ?`, n.key, r.seq).one().data) };
      }
      const from = pos + done - r.start;
      if (from < 0 || from >= r.len) continue;
      const take = Math.min(r.len - from, dst.length - done);
      dst.set(n.cache.data.subarray(from, from + take), done);
      done += take;
    }
    this.stats.reads++;
    this.stats.readBytes += done;
    return done;
  }

  #truncate(n, size) {
    if (n.path.startsWith("\0deleted:")) return; // an unlinked-but-open file: its rows are gone
    this.#flush(n);
    if (size >= n.size) {
      if (size > n.size) this.#append(n, new Uint8Array(size - n.size), true);
      return;
    }
    const keep = new Uint8Array(size);
    this.#readAt(n, 0, keep);
    this.#write(`DELETE FROM vfs_chunk WHERE path = ?`, n.key);
    n.nextSeq = 0;
    n.size = 0;
    n.tail = null;
    this.#append(n, keep, true);
  }

  #append(n, bytes, writeThrough) {
    n.pending.push(bytes.slice());
    n.pendingLen += bytes.length;
    n.size += bytes.length;
    if (writeThrough || n.pendingLen >= VFS_CHUNK) this.#flush(n);
  }

  #filestat(ptr, isDir, size) {
    const dv = this.#dv();
    for (let i = 0; i < 64; i += 8) dv.setBigUint64(ptr + i, 0n, true);
    dv.setUint8(ptr + 16, isDir ? FT.DIR : FT.FILE);
    dv.setBigUint64(ptr + 24, 1n, true);
    dv.setBigUint64(ptr + 32, BigInt(size), true);
    const now = BigInt(Date.now()) * 1_000_000n;
    dv.setBigUint64(ptr + 40, now, true);
    dv.setBigUint64(ptr + 48, now, true);
    dv.setBigUint64(ptr + 56, now, true);
  }

  // ---- WASI imports (only the file-related ones; the caller merges stdio/clock/etc.) ----
  imports() {
    return {
      fd_prestat_get: (fd, ptr) => {
        if (fd !== PREOPEN_FD) return E.BADF;
        const dv = this.#dv();
        dv.setUint8(ptr, 0);
        dv.setUint32(ptr + 4, PREOPEN_NAME.length, true);
        return E.OK;
      },
      fd_prestat_dir_name: (fd, ptr, len) => {
        if (fd !== PREOPEN_FD) return E.BADF;
        this.#u8().set(new TextEncoder().encode(PREOPEN_NAME).subarray(0, len), ptr);
        return E.OK;
      },
      path_open: (dirfd, _dirflags, pathPtr, pathLen, oflags, _rb, _ri, fdflags, fdOut) => {
        const path = this.#resolve(dirfd, pathPtr, pathLen);
        if (path === null) return E.BADF;
        const row = path === "" ? { is_dir: 1, size: 0 } : this.#row(path);
        if (row?.is_dir) {
          if (oflags & (O.CREAT | O.TRUNC) && !(oflags & O.DIRECTORY)) return E.ISDIR;
          const fd = this.#nextFd++;
          this.#fds.set(fd, { node: { path }, pos: 0, append: false, dir: true });
          this.#dv().setUint32(fdOut, fd, true);
          return E.OK;
        }
        if (oflags & O.DIRECTORY) return row ? E.NOTDIR : E.NOENT;
        if (row && oflags & O.CREAT && oflags & O.EXCL) return E.EXIST;
        if (!row) {
          if (!(oflags & O.CREAT)) return E.NOENT;
          const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
          if (parent && !this.#row(parent)?.is_dir) return E.NOENT;
          this.#write(`INSERT INTO vfs_node (path, is_dir, size, chunks) VALUES (?, 0, 0, ?)`, path, `#${crypto.randomUUID()}`);
        }
        const n = this.#node(path);
        if (oflags & O.TRUNC && n.size) this.#truncate(n, 0);
        const fd = this.#nextFd++;
        this.#fds.set(fd, { node: n, pos: 0, append: !!(fdflags & FD_APPEND), dir: false });
        this.#dv().setUint32(fdOut, fd, true);
        return E.OK;
      },
      fd_close: (fd) => {
        const f = this.#fds.get(fd);
        if (!f) return fd <= 2 ? E.OK : E.BADF;
        if (!f.dir) this.#flush(f.node);
        this.#fds.delete(fd);
        return E.OK;
      },
      fd_sync: (fd) => {
        const f = this.#fds.get(fd);
        if (f && !f.dir) this.#flush(f.node);
        return E.OK;
      },
      fd_write: null, // handled by the caller so stdout/stderr and files share one function
      fd_read: (fd, iovs, iovsLen, nreadPtr) => {
        const f = this.#fds.get(fd);
        if (!f || f.dir) return E.BADF;
        const dv = this.#dv();
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const p = dv.getUint32(iovs + i * 8, true), len = dv.getUint32(iovs + i * 8 + 4, true);
          const n = this.#readAt(f.node, f.pos, this.#u8().subarray(p, p + len));
          f.pos += n;
          total += n;
          if (n < len) break;
        }
        this.#dv().setUint32(nreadPtr, total, true);
        return E.OK;
      },
      fd_pread: (fd, iovs, iovsLen, offset, nreadPtr) => {
        const f = this.#fds.get(fd);
        if (!f || f.dir) return E.BADF;
        const dv = this.#dv();
        let pos = Number(offset), total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const p = dv.getUint32(iovs + i * 8, true), len = dv.getUint32(iovs + i * 8 + 4, true);
          const n = this.#readAt(f.node, pos, this.#u8().subarray(p, p + len));
          pos += n;
          total += n;
          if (n < len) break;
        }
        this.#dv().setUint32(nreadPtr, total, true);
        return E.OK;
      },
      fd_seek: (fd, offset, whence, outPtr) => {
        const f = this.#fds.get(fd);
        if (!f || f.dir) return E.BADF;
        const base = whence === 0 ? 0 : whence === 1 ? f.pos : f.node.size;
        const pos = base + Number(offset);
        if (pos < 0) return E.INVAL;
        f.pos = pos;
        this.#dv().setBigUint64(outPtr, BigInt(pos), true);
        return E.OK;
      },
      fd_filestat_get: (fd, ptr) => {
        if (fd <= 2) { this.#filestat(ptr, false, 0); this.#dv().setUint8(ptr + 16, FT.CHAR); return E.OK; }
        if (fd === PREOPEN_FD) { this.#filestat(ptr, true, 0); return E.OK; }
        const f = this.#fds.get(fd);
        if (!f) return E.BADF;
        this.#filestat(ptr, f.dir, f.dir ? 0 : f.node.size);
        return E.OK;
      },
      fd_filestat_set_size: (fd, size) => {
        const f = this.#fds.get(fd);
        if (!f || f.dir) return E.BADF;
        this.#truncate(f.node, Number(size));
        return E.OK;
      },
      path_filestat_get: (dirfd, _flags, pathPtr, pathLen, ptr) => {
        const path = this.#resolve(dirfd, pathPtr, pathLen);
        if (path === null) return E.BADF;
        if (path === "") { this.#filestat(ptr, true, 0); return E.OK; }
        const n = this.#nodes.get(path);
        const row = n ? { is_dir: 0, size: n.size } : this.#row(path);
        if (!row) return E.NOENT;
        this.#filestat(ptr, !!row.is_dir, row.size);
        return E.OK;
      },
      fd_fdstat_get: (fd, ptr) => {
        const dv = this.#dv();
        new Uint8Array(this.#mem().buffer, ptr, 24).fill(0);
        let type;
        if (fd <= 2) type = FT.CHAR;
        else if (fd === PREOPEN_FD) type = FT.DIR;
        else { const f = this.#fds.get(fd); if (!f) return E.BADF; type = f.dir ? FT.DIR : FT.FILE; if (f.append) dv.setUint16(ptr + 2, FD_APPEND, true); }
        dv.setUint8(ptr, type);
        dv.setBigUint64(ptr + 8, 0xffffffffffffffffn, true);
        dv.setBigUint64(ptr + 16, 0xffffffffffffffffn, true);
        return E.OK;
      },
      fd_fdstat_set_flags: (fd, flags) => {
        const f = this.#fds.get(fd);
        if (f) f.append = !!(flags & FD_APPEND);
        return E.OK;
      },
      fd_readdir: (fd, buf, bufLen, cookie, usedPtr) => {
        const f = fd === PREOPEN_FD ? { dir: true, node: { path: "" } } : this.#fds.get(fd);
        if (!f?.dir) return E.BADF;
        const prefix = f.node.path ? f.node.path + "/" : "";
        const names = this.#sql.exec(`SELECT path, is_dir FROM vfs_node WHERE path LIKE ? ORDER BY path`, prefix + "%").toArray()
          .filter((r) => !r.path.slice(prefix.length).includes("/"));
        const enc = new TextEncoder(), u8 = this.#u8(), dv = this.#dv();
        let used = 0;
        for (let i = Number(cookie); i < names.length; i++) {
          const name = enc.encode(names[i].path.slice(prefix.length));
          const ent = new Uint8Array(24 + name.length), edv = new DataView(ent.buffer);
          edv.setBigUint64(0, BigInt(i + 1), true);
          edv.setBigUint64(8, BigInt(i + 1), true);
          edv.setUint32(16, name.length, true);
          edv.setUint8(20, names[i].is_dir ? FT.DIR : FT.FILE);
          ent.set(name, 24);
          const take = Math.min(ent.length, bufLen - used);
          u8.set(ent.subarray(0, take), buf + used);
          used += take;
          if (used >= bufLen) break;
        }
        dv.setUint32(usedPtr, used, true);
        return E.OK;
      },
      fd_renumber: (from, to) => {
        const f = this.#fds.get(from);
        if (!f) return E.BADF;
        this.#fds.delete(from);
        this.#fds.set(to, f);
        return E.OK;
      },
      path_create_directory: (dirfd, pathPtr, pathLen) => {
        const path = this.#resolve(dirfd, pathPtr, pathLen);
        if (path === null) return E.BADF;
        if (path === "" || this.#row(path)) return E.EXIST;
        this.#write(`INSERT INTO vfs_node (path, is_dir, size) VALUES (?, 1, 0)`, path);
        return E.OK;
      },
      path_remove_directory: (dirfd, pathPtr, pathLen) => {
        const path = this.#resolve(dirfd, pathPtr, pathLen);
        if (!path) return E.INVAL;
        if (!this.#row(path)?.is_dir) return E.NOTDIR;
        if (this.#sql.exec(`SELECT 1 FROM vfs_node WHERE path LIKE ? LIMIT 1`, path + "/%").toArray().length) return E.NOTEMPTY;
        this.#write(`DELETE FROM vfs_node WHERE path = ?`, path);
        return E.OK;
      },
      path_rename: (oldDir, oldPtr, oldLen, newDir, newPtr, newLen) => {
        const from = this.#resolve(oldDir, oldPtr, oldLen), to = this.#resolve(newDir, newPtr, newLen);
        if (from === null || to === null) return E.BADF;
        const row = this.#row(from);
        if (row && from === to) return E.OK;
        if (!row) return E.NOENT;
        const n = this.#nodes.get(from);
        if (n) this.#flush(n);
        this.#unlink(to);
        this.#write(`UPDATE vfs_node SET path = ?, chunks = coalesce(chunks, ?) WHERE path = ?`, to, from, from);
        if (n) { this.#nodes.delete(from); n.path = to; this.#nodes.set(to, n); }
        return E.OK;
      },
      path_unlink_file: (dirfd, pathPtr, pathLen) => {
        const path = this.#resolve(dirfd, pathPtr, pathLen);
        if (path === null) return E.BADF;
        const row = this.#row(path);
        if (!row) return E.NOENT;
        if (row.is_dir) return E.ISDIR;
        this.#unlink(path);
        return E.OK;
      },
    };
  }

  #unlink(path) {
    const n = this.#nodes.get(path), key = n?.key ?? this.#row(path)?.key;
    if (n) { n.pending = []; n.pendingLen = 0; this.#nodes.delete(path); n.path = `\0deleted:${path}`; }
    // A key is never reused (new files get a fresh one), so its chunks can go later.
    if (key !== undefined) { this.#write(`INSERT OR IGNORE INTO vfs_trash (key) VALUES (?)`, key); this.onTrash?.(); }
    this.#write(`DELETE FROM vfs_node WHERE path = ?`, path);
  }

  // fd_write for VFS fds. Returns null if `fd` is not ours (stdio).
  write(fd, chunks) {
    const f = this.#fds.get(fd);
    if (!f) return null;
    if (f.dir) return E.BADF;
    const n = f.node;
    if (n.path.startsWith("\0deleted:")) return E.OK; // writes to an unlinked-but-open file vanish
    let total = 0;
    for (const c of chunks) total += c.length;
    const pos = f.append ? n.size : f.pos;
    if (pos !== n.size) {
      // Overwrite in the middle: rare (not used by Valkey's AOF/RDB paths). Rewrite the file.
      const all = new Uint8Array(Math.max(n.size, pos + total));
      this.#readAt(n, 0, all.subarray(0, n.size));
      let o = pos;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      this.#write(`DELETE FROM vfs_chunk WHERE path = ?`, n.key);
      n.nextSeq = 0; n.size = 0; n.pending = []; n.pendingLen = 0; n.tail = null;
      this.#append(n, all, true);
    } else {
      for (const c of chunks) this.#append(n, c, false);
      if (f.append) this.#flush(n); // the AOF: durable before Valkey's reply goes out
      // The AOF incr file is only ever appended to; Valkey opens it without O_APPEND under WASI.
      if (this.onAppend && n.path.endsWith(".incr.aof")) this.onAppend(chunks.length === 1 ? chunks[0].slice() : concatBytes(chunks, total));
    }
    f.pos = pos + total;
    return E.OK;
  }

  /** Bytes [pos, pos + len) of the file at `path` (relative to the root), or null if it doesn't exist. */
  read(path, pos, len) {
    const n = this.#node(path);
    if (!n) return null;
    const dst = new Uint8Array(Math.max(0, Math.min(len, n.size - pos)));
    this.#readAt(n, pos, dst);
    return dst;
  }

  size(path) {
    return this.#node(path)?.size ?? null;
  }

  /** Deletes up to `rows` chunks of deleted files. Returns whether any are left. */
  sweep(rows) {
    const t = this.#sql.exec(`SELECT key FROM vfs_trash LIMIT 1`).toArray()[0];
    if (!t) return false;
    const r = this.#sql.exec(`DELETE FROM vfs_chunk WHERE path = ? AND seq IN (SELECT seq FROM vfs_chunk WHERE path = ? ORDER BY seq DESC LIMIT ?)`, t.key, t.key, rows);
    this.stats.rowsWritten += r.rowsWritten;
    if (!r.rowsWritten) this.#write(`DELETE FROM vfs_trash WHERE key = ?`, t.key);
    return true;
  }

  // ---- host-side file access (outside Valkey: a rewrite helper's copy of a shard's files, a base it sends back) ----
  /** Deletes every file and directory. */
  clear() {
    this.#write(`DELETE FROM vfs_chunk`);
    this.#write(`DELETE FROM vfs_node`);
    this.#write(`DELETE FROM vfs_trash`);
    this.#nodes.clear();
  }

  /** Appends to the file at `path`, creating it (and its directory) if missing. Buffered like a non-AOF fd: see flush. */
  append(path, bytes) {
    let n = this.#node(path);
    if (!n) {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir && !this.#row(dir)) this.#write(`INSERT INTO vfs_node (path, is_dir, size) VALUES (?, 1, 0)`, dir);
      this.#write(`INSERT INTO vfs_node (path, is_dir, size, chunks) VALUES (?, 0, 0, ?)`, path, `#${crypto.randomUUID()}`);
      n = this.#node(path);
    }
    this.#append(n, bytes, false);
  }

  /** Writes out what append() buffered. */
  flush() {
    for (const n of this.#nodes.values()) this.#flush(n);
  }

  remove(path) {
    if (this.#row(path)) this.#unlink(path);
  }

  listing() {
    return this.#sql.exec(`SELECT n.path, n.is_dir, coalesce((SELECT sum(length(c.data)) FROM vfs_chunk c WHERE c.path = coalesce(n.chunks, n.path)), 0) AS size, (SELECT count(*) FROM vfs_chunk c WHERE c.path = coalesce(n.chunks, n.path)) AS rows FROM vfs_node n ORDER BY n.path`).toArray();
  }
}
