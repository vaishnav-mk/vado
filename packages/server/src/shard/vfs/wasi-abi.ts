// WASI preview1 numbers the Vfs speaks, and its fd table.
import type { OpenFd } from "./types";

export const PREOPEN_FD = 3;
export const PREOPEN_NAME = "/data";

export const E = { OK: 0, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, NOENT: 44, NOTDIR: 54 } as const;
export const FILETYPE = { CHAR: 2, DIR: 3, FILE: 4 } as const;
export const OFLAG = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 } as const;
export const FD_APPEND = 1;

export function writeFilestat(dv: DataView, ptr: number, filetype: number, size: number): void {
  for (let i = 0; i < 64; i += 8) dv.setBigUint64(ptr + i, 0n, true);
  dv.setUint8(ptr + 16, filetype);
  dv.setBigUint64(ptr + 24, 1n, true);
  dv.setBigUint64(ptr + 32, BigInt(size), true);
  const now = BigInt(Date.now()) * 1_000_000n;
  dv.setBigUint64(ptr + 40, now, true);
  dv.setBigUint64(ptr + 48, now, true);
  dv.setBigUint64(ptr + 56, now, true);
}

export class FdTable {
  readonly #open = new Map<number, OpenFd>();
  #next = PREOPEN_FD + 1;

  add(entry: OpenFd): number {
    const fd = this.#next++;
    this.#open.set(fd, entry);

    return fd;
  }

  get(fd: number): OpenFd | undefined {
    return this.#open.get(fd);
  }

  file(fd: number) {
    const entry = this.#open.get(fd);

    return entry?.dir === false ? entry : undefined;
  }

  delete(fd: number): void {
    this.#open.delete(fd);
  }

  set(fd: number, entry: OpenFd): void {
    this.#open.set(fd, entry);
  }
}
