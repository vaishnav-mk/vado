import { concat } from "../protocol/resp";
import { sameBytes } from "../protocol/bytes";
import { encoder } from "../shared";
import { BASE } from "./store";
import type { BoxStore } from "./store";
import { RDB_CHUNK } from "./config";

const EOF_MARK = 40;

// "$<len>", or diskless "$EOF:<mark>" ending in the mark. After a diskless copy the server sends nothing until this
// replica's first ACK, so the mark ends a read. Returns the bytes read past the end.
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

    for (let i = 0; i + keep < all.length; i += RDB_CHUNK)
      store.append(gen, BASE, all.slice(i, Math.min(i + RDB_CHUNK, all.length - keep)));
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

      if (sameBytes(tail, mark)) {
        flush(EOF_MARK);
        await committed;

        return buf;
      }
    }

    if (size >= RDB_CHUNK + EOF_MARK) {
      flush(mark ? EOF_MARK : 0);
      // Read on only once the window before is durable: at most two sit unstored.
      await committed;
      committed = store.sync();
    }
  }

  flush(0);
  await committed;

  return buf;
}
