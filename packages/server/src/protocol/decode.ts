// Decoding whole RESP frames, for the paths that read replies (fan-out merges, admin, the shard's own commands).
import { frameEnd, lineEnd, num } from "./resp";
import type { Reply, TypedReply } from "./types";
import { decoder } from "../shared";

/** Decodes the frame at `i`: the value and the offset after it. Bulk strings become strings, errors `{ err }`. */
export function decode(b: Uint8Array, i = 0): [Reply, number] {
  const t = b[i];
  const le = lineEnd(b, i + 1, b.length);

  if (le < 0) throw new Error("incomplete RESP frame");
  const line = () => decoder.decode(b.subarray(i + 1, le));

  switch (t) {
    case 43:
      return [line(), le + 2];
    case 45:
      return [{ err: line() }, le + 2];
    case 58:
      return [num(b, i + 1, le), le + 2];
    case 95:
      return [null, le + 2];
    case 35:
      return [b[i + 1] === 116, le + 2];
    case 44:
      return [Number(line()), le + 2];
    case 40:
      return [BigInt(line()), le + 2];
    case 36:
    case 33:
    case 61: {
      const n = num(b, i + 1, le);

      if (n < 0) return [null, le + 2];
      let s = b.subarray(le + 2, le + 2 + n);

      // Verbatim strings start "txt:".
      if (t === 61) s = s.subarray(4);
      const text = decoder.decode(s);

      return [t === 33 ? { err: text } : text, le + 4 + n];
    }

    case 42:
    case 126:
    case 62: {
      const n = num(b, i + 1, le);

      if (n < 0) return [null, le + 2];
      const out: Reply[] = [];
      let j = le + 2;

      for (let k = 0; k < n; k++) {
        const [v, next] = decode(b, j);
        out.push(v);
        j = next;
      }

      return [out, j];
    }

    case 37: {
      const n = num(b, i + 1, le);
      const out = new Map<Reply, Reply>();
      let j = le + 2;

      for (let k = 0; k < n; k++) {
        const [key, a] = decode(b, j);
        const [v, c] = decode(b, a);
        out.set(key, v);
        j = c;
      }

      return [out, j];
    }

    // An attribute: drop it, keep the reply it annotates.
    case 124: {
      let j = le + 2;
      const n = num(b, i + 1, le) * 2;

      for (let k = 0; k < n; k++) j = frameEnd(b, j, b.length);

      return decode(b, j);
    }

    default:
      throw new Error(`RESP protocol error: unexpected byte ${t}`);
  }
}

/** Every frame in `b`, decoded. */
export function decodeAll(b: Uint8Array): Reply[] {
  const out = [];

  for (let i = 0; i < b.length;) {
    const [v, next] = decode(b, i);
    out.push(v);
    i = next;
  }

  return out;
}

/** Decodes the RESP2 reply at `i` keeping its type, so it can be shown as valkey-cli does (a status reply OK
 *  unquoted, a bulk string "OK" quoted). */
export function decodeTyped(b: Uint8Array, i = 0): [TypedReply, number] {
  const t = b[i];
  const le = lineEnd(b, i + 1, b.length);

  if (le < 0) throw new Error("incomplete RESP frame");
  const line = () => decoder.decode(b.subarray(i + 1, le));

  switch (t) {
    case 43:
      return [{ type: "status", value: line() }, le + 2];
    case 45:
      return [{ type: "error", value: line() }, le + 2];
    case 58:
      return [{ type: "integer", value: num(b, i + 1, le) }, le + 2];
    case 36: {
      const n = num(b, i + 1, le);

      return n < 0
        ? [{ type: "nil" }, le + 2]
        : [{ type: "bulk", value: decoder.decode(b.subarray(le + 2, le + 2 + n)) }, le + 4 + n];
    }

    case 42: {
      const n = num(b, i + 1, le);

      if (n < 0) return [{ type: "nil" }, le + 2];
      const value: TypedReply[] = [];
      let j = le + 2;

      for (let k = 0; k < n; k++) {
        const [v, next] = decodeTyped(b, j);
        value.push(v);
        j = next;
      }

      return [{ type: "array", value }, j];
    }

    default:
      throw new Error(`RESP protocol error: unexpected byte ${t} in a RESP2 reply`);
  }
}
