import { iovecs } from "./memory";
import type { Store } from "./store";
import type { Views } from "./types";
import { E, FD_APPEND, FILETYPE, type FdTable, PREOPEN_FD, PREOPEN_NAME, writeFilestat } from "./wasi-abi";

const encoder = new TextEncoder();
const PREOPEN = encoder.encode(PREOPEN_NAME);

/** WASI imports on fds (fd_write is the host's: stdio and files share it). */
export function fdImports(fds: FdTable, store: Store, { u8, dv }: Views) {
  return {
    fd_prestat_get: (fd: number, ptr: number) => {
      if (fd !== PREOPEN_FD) return E.BADF;
      dv().setUint8(ptr, 0);
      dv().setUint32(ptr + 4, PREOPEN.length, true);

      return E.OK;
    },
    fd_prestat_dir_name: (fd: number, ptr: number, len: number) => {
      if (fd !== PREOPEN_FD) return E.BADF;
      u8().set(PREOPEN.subarray(0, len), ptr);

      return E.OK;
    },
    fd_close: (fd: number) => {
      const f = fds.get(fd);

      if (!f) return fd <= 2 ? E.OK : E.BADF;

      if (!f.dir) store.flush(f.node);
      fds.delete(fd);

      return E.OK;
    },
    fd_sync: (fd: number) => {
      const f = fds.file(fd);

      if (f) store.flush(f.node);

      return E.OK;
    },
    fd_read: (fd: number, iovs: number, count: number, nreadPtr: number) => {
      const f = fds.file(fd);

      if (!f) return E.BADF;
      let total = 0;

      for (const buffer of iovecs(u8().buffer, dv(), iovs, count)) {
        const n = store.readAt(f.node, f.pos, buffer);
        f.pos += n;
        total += n;

        if (n < buffer.length) break;
      }

      dv().setUint32(nreadPtr, total, true);

      return E.OK;
    },
    fd_seek: (fd: number, offset: bigint, whence: number, outPtr: number) => {
      const f = fds.file(fd);

      if (!f) return E.BADF;
      const pos = (whence === 0 ? 0 : whence === 1 ? f.pos : f.node.size) + Number(offset);

      if (pos < 0) return E.INVAL;
      f.pos = pos;
      dv().setBigUint64(outPtr, BigInt(pos), true);

      return E.OK;
    },
    fd_filestat_get: (fd: number, ptr: number) => {
      if (fd <= 2) writeFilestat(dv(), ptr, FILETYPE.CHAR, 0);
      else if (fd === PREOPEN_FD) writeFilestat(dv(), ptr, FILETYPE.DIR, 0);
      else {
        const f = fds.get(fd);

        if (!f) return E.BADF;

        if (f.dir) writeFilestat(dv(), ptr, FILETYPE.DIR, 0);
        else writeFilestat(dv(), ptr, FILETYPE.FILE, f.node.size);
      }

      return E.OK;
    },
    fd_filestat_set_size: (fd: number, size: bigint) => {
      const f = fds.file(fd);

      if (!f) return E.BADF;
      store.truncate(f.node, Number(size));

      return E.OK;
    },
    fd_fdstat_get: (fd: number, ptr: number) => {
      const view = dv();
      u8().fill(0, ptr, ptr + 24);
      let filetype: number = FILETYPE.CHAR;

      if (fd === PREOPEN_FD) filetype = FILETYPE.DIR;
      else if (fd > 2) {
        const f = fds.get(fd);

        if (!f) return E.BADF;
        filetype = f.dir ? FILETYPE.DIR : FILETYPE.FILE;

        if (!f.dir && f.append) view.setUint16(ptr + 2, FD_APPEND, true);
      }

      view.setUint8(ptr, filetype);
      view.setBigUint64(ptr + 8, 0xffffffffffffffffn, true);
      view.setBigUint64(ptr + 16, 0xffffffffffffffffn, true);

      return E.OK;
    },
    fd_fdstat_set_flags: (fd: number, flags: number) => {
      const f = fds.file(fd);

      if (f) f.append = (flags & FD_APPEND) !== 0;

      return E.OK;
    },
    fd_readdir: (fd: number, buf: number, bufLen: number, cookie: bigint, usedPtr: number) => {
      const f = fds.get(fd);
      const dir = fd === PREOPEN_FD ? "" : f?.dir ? f.path : null;

      if (dir === null) return E.BADF;
      const prefix = dir ? dir + "/" : "";
      const names = store.children(prefix);
      const memory = u8();
      let used = 0;

      for (let i = Number(cookie); i < names.length && used < bufLen; i++) {
        const name = encoder.encode(names[i].path.slice(prefix.length));
        const entry = new Uint8Array(24 + name.length);
        const view = new DataView(entry.buffer);
        view.setBigUint64(0, BigInt(i + 1), true);
        view.setBigUint64(8, BigInt(i + 1), true);
        view.setUint32(16, name.length, true);
        view.setUint8(20, names[i].isDir ? FILETYPE.DIR : FILETYPE.FILE);
        entry.set(name, 24);
        const take = Math.min(entry.length, bufLen - used);
        memory.set(entry.subarray(0, take), buf + used);
        used += take;
      }

      dv().setUint32(usedPtr, used, true);

      return E.OK;
    },
    fd_renumber: (from: number, to: number) => {
      const f = fds.get(from);

      if (!f) return E.BADF;
      fds.delete(from);
      fds.set(to, f);

      return E.OK;
    },
  };
}
