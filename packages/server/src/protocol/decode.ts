import { frameEnd, lineEnd, num, str } from "./resp";
import type { Reply, TypedReply } from "./types";

function header(b: Uint8Array, i: number): [number, number, () => string] {
  const le = lineEnd(b, i + 1, b.length);

  if (le < 0) throw new Error("incomplete RESP frame");

  return [b[i], le, () => str(b.subarray(i + 1, le))];
}

function items<T>(
  b: Uint8Array,
  j: number,
  n: number,
  parse: (b: Uint8Array, i: number) => [T, number],
): [T[], number] {
  const out: T[] = [];

  for (let k = 0; k < n; k++) {
    const [v, next] = parse(b, j);
    out.push(v);
    j = next;
  }

  return [out, j];
}

export function decode(b: Uint8Array, i = 0): [Reply, number] {
  const [t, le, line] = header(b, i);

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
      const text = str(s);

      return [t === 33 ? { err: text } : text, le + 4 + n];
    }

    case 42:
    case 126:
    case 62: {
      const n = num(b, i + 1, le);

      return n < 0 ? [null, le + 2] : items(b, le + 2, n, decode);
    }

    case 37: {
      const [kv, j] = items(b, le + 2, num(b, i + 1, le) * 2, decode);
      const out = new Map<Reply, Reply>();

      for (let k = 0; k < kv.length; k += 2) out.set(kv[k], kv[k + 1]);

      return [out, j];
    }

    // An attribute annotates the reply after it: dropped.
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

export function decodeAll(b: Uint8Array): Reply[] {
  const out = [];

  for (let i = 0; i < b.length;) {
    const [v, next] = decode(b, i);
    out.push(v);
    i = next;
  }

  return out;
}

// Keeps the type so a reply shows as valkey-cli shows it: status OK unquoted, bulk "OK" quoted.
export function decodeTyped(b: Uint8Array, i = 0): [TypedReply, number] {
  const [t, le, line] = header(b, i);

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
        : [{ type: "bulk", value: str(b.subarray(le + 2, le + 2 + n)) }, le + 4 + n];
    }

    case 42: {
      const n = num(b, i + 1, le);

      if (n < 0) return [{ type: "nil" }, le + 2];
      const [value, j] = items(b, le + 2, n, decodeTyped);

      return [{ type: "array", value }, j];
    }

    default:
      throw new Error(`RESP protocol error: unexpected byte ${t} in a RESP2 reply`);
  }
}
