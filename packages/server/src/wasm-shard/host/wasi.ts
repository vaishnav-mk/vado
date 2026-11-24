import { iovecs } from "../vfs/memory";
import type { Views } from "../vfs/types";
import type { Vfs } from "../vfs/vfs";
import { decoder } from "../../shared";

const EBADF = 8;
const ENOSYS = 52;
const enosys = () => ENOSYS;

export function wasiImports({ u8, dv }: Views, vfs: Vfs, log: (line: string) => void) {
  const partial = ["", "", ""]; // stdout and stderr: the line so far
  // The clock advances only across I/O, and Valkey reads it ~10 times a step.
  let clockMs = -1;
  let clockNs = 0n;

  return {
    ...vfs.imports(),
    environ_sizes_get: (count: number, size: number) => {
      dv().setUint32(count, 0, true);
      dv().setUint32(size, 0, true);

      return 0;
    },
    environ_get: () => 0,
    clock_time_get: (_id: number, _precision: bigint, ptr: number) => {
      const ms = Date.now();

      if (ms !== clockMs) {
        clockMs = ms;
        clockNs = BigInt(ms) * 1_000_000n;
      }

      dv().setBigUint64(ptr, clockNs, true);

      return 0;
    },
    poll_oneoff: (_in: number, _out: number, _count: number, events: number) => {
      dv().setUint32(events, 0, true);

      return 0;
    },
    sched_yield: () => 0,
    proc_exit: (code: number) => {
      throw new Error(`valkey exited with code ${code}`);
    },
    fd_write: (fd: number, iovs: number, count: number, writtenPtr: number) => {
      const view = dv();
      const chunks = iovecs(u8().buffer, view, iovs, count);
      const rc = vfs.write(fd, chunks);

      if (rc === null) {
        if (fd !== 1 && fd !== 2) return EBADF;
        let text = partial[fd];

        for (const c of chunks) text += decoder.decode(c);
        const lines = text.split("\n");
        partial[fd] = lines.pop() ?? "";

        for (const line of lines) if (line) log(line);
      } else if (rc !== 0) return rc;
      let written = 0;

      for (const c of chunks) written += c.length;
      view.setUint32(writtenPtr, written, true);

      return 0;
    },
    sock_shutdown: enosys,
    path_link: enosys,
    path_readlink: enosys,
  };
}
