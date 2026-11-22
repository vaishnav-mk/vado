import type { Store } from "./store";
import type { Views } from "./types";
import { E, FD_APPEND, FILETYPE, type FdTable, OFLAG, PREOPEN_FD, writeFilestat } from "./wasi-abi";

const decoder = new TextDecoder();

export const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** `path` relative to directory `dir` ("" is the preopen root), with "." and ".." resolved. */
export function resolvePath(dir: string, path: string): string {
  const parts = dir ? dir.split("/") : [];

  for (const p of path.split("/")) {
    if (p === "" || p === ".") continue;

    if (p === "..") parts.pop();
    else parts.push(p);
  }

  return parts.join("/");
}

/** WASI imports on paths. */
export function pathImports(fds: FdTable, store: Store, { u8, dv }: Views) {
  // A path argument, as a key under the preopen root; null if `dirfd` isn't a directory.
  const resolve = (dirfd: number, ptr: number, len: number) => {
    let dir = "";

    if (dirfd !== PREOPEN_FD) {
      const f = fds.get(dirfd);

      if (!f?.dir) return null;
      dir = f.path;
    }

    return resolvePath(dir, decoder.decode(u8().subarray(ptr, ptr + len)));
  };

  return {
    path_open: (
      dirfd: number,
      _dirflags: number,
      pathPtr: number,
      pathLen: number,
      oflags: number,
      _rightsBase: bigint,
      _rightsInheriting: bigint,
      fdflags: number,
      fdOut: number,
    ) => {
      const path = resolve(dirfd, pathPtr, pathLen);

      if (path === null) return E.BADF;
      const row = path === "" ? { isDir: 1 } : store.row(path);

      if (row?.isDir) {
        if (oflags & (OFLAG.CREAT | OFLAG.TRUNC) && !(oflags & OFLAG.DIRECTORY)) return E.ISDIR;
        dv().setUint32(fdOut, fds.add({ dir: true, path }), true);

        return E.OK;
      }

      if (oflags & OFLAG.DIRECTORY) return row ? E.NOTDIR : E.NOENT;

      if (row && oflags & OFLAG.CREAT && oflags & OFLAG.EXCL) return E.EXIST;

      if (!row) {
        if (!(oflags & OFLAG.CREAT)) return E.NOENT;
        const parent = parentOf(path);

        if (parent && !store.row(parent)?.isDir) return E.NOENT;
      }

      const node = row ? store.node(path) : store.create(path);

      if (!node) return E.NOENT;

      if (oflags & OFLAG.TRUNC && node.size) store.truncate(node, 0);
      dv().setUint32(fdOut, fds.add({ dir: false, node, pos: 0, append: (fdflags & FD_APPEND) !== 0 }), true);

      return E.OK;
    },
    path_filestat_get: (dirfd: number, _flags: number, pathPtr: number, pathLen: number, ptr: number) => {
      const path = resolve(dirfd, pathPtr, pathLen);

      if (path === null) return E.BADF;

      if (path === "") {
        writeFilestat(dv(), ptr, FILETYPE.DIR, 0);

        return E.OK;
      }

      const cached = store.cached(path);
      const row = cached ? { isDir: 0, size: cached.size } : store.row(path);

      if (!row) return E.NOENT;
      writeFilestat(dv(), ptr, row.isDir ? FILETYPE.DIR : FILETYPE.FILE, row.size);

      return E.OK;
    },
    path_create_directory: (dirfd: number, pathPtr: number, pathLen: number) => {
      const path = resolve(dirfd, pathPtr, pathLen);

      if (path === null) return E.BADF;

      if (path === "" || store.row(path)) return E.EXIST;
      store.mkdir(path);

      return E.OK;
    },
    path_rename: (oldDir: number, oldPtr: number, oldLen: number, newDir: number, newPtr: number, newLen: number) => {
      const from = resolve(oldDir, oldPtr, oldLen);
      const to = resolve(newDir, newPtr, newLen);

      if (from === null || to === null) return E.BADF;
      const row = store.row(from);

      if (!row) return E.NOENT;

      if (from !== to) store.rename(from, to);

      return E.OK;
    },
    path_unlink_file: (dirfd: number, pathPtr: number, pathLen: number) => {
      const path = resolve(dirfd, pathPtr, pathLen);

      if (path === null) return E.BADF;
      const row = store.row(path);

      if (!row) return E.NOENT;

      if (row.isDir) return E.ISDIR;
      store.unlink(path);

      return E.OK;
    },
  };
}
