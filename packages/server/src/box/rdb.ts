import { concat } from "../protocol/resp";
import { encoder } from "../shared";
import { BASE } from "./store";
import type { BoxStore } from "./store";

const CHUNK = 1 << 20;

const EOF_MARK = 40;

// Stores an RDB transfer as generation `gen`'s base: "$<len>" or, diskless, "$EOF:<40 bytes>" with the same 40 bytes
// after the payload. `buf` holds bytes already read; returns those read past the end. After a diskless copy the server
// sends nothing until this replica's first ACK, so its mark ends a read.
export async function storeRdb(
  store: BoxStore,
  gen: number,
  header: string,
  buf: Uint8Array,
  read: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const mark = header.startsWith("$EOF:") ? encoder.encode(header.slice(5)) : null;
  let left = mark ? Infinity : Number(header.slice(1));

  let pending: Uint8Array[] = [],
    size = 0,
    tail: Uint8Array = new Uint8Array(0),
    committed = Promise.resolve();

  const flush = (keep: number) => {
    const all = concat(pending);

    for (let i = 0; i + keep < all.length; i += CHUNK)
      store.append(gen, BASE, all.slice(i, Math.min(i + CHUNK, all.length - keep)));
    pending = keep ? [all.slice(all.length - keep)] : [];
    size = keep ? Math.min(keep, all.length) : 0;
  };

  while (left > 0) {
    const part = buf.length ? buf : await read();
    const take = mark ? part.length : Math.min(left, part.length);

    pending.push(part.subarray(0, take));
    size += take;
    buf = part.subarray(take);
    left -= take;

    if (mark) {
      tail = concat([tail, part.subarray(0, take)]).subarray(-EOF_MARK);

      if (tail.length === EOF_MARK && tail.every((b, i) => b === mark[i])) {
        flush(EOF_MARK);
        await committed;

        return buf;
      }
    }

    if (size >= CHUNK + EOF_MARK) {
      flush(mark ? EOF_MARK : 0);
      // Uncommitted writes are held in this object's memory, and replies wait behind them: read on only once the
      // window before is durable, so at most two windows are ever pending.
      await committed;
      committed = store.sync();
    }
  }

  flush(0);
  await committed;

  return buf;
}
