// RESP2/RESP3 frames on bytes: where each ends (for proxying) and encoding.
import type { CommandArg, FrameResume } from "./types";
import { decoder, encoder } from "../shared";

const CR = 13;
const LF = 10;
const CRLF = encoder.encode("\r\n");

/** The offset of the next CRLF in `b[i..end)`, or -1. */
export function lineEnd(b: Uint8Array, i: number, end: number): number {
  for (let j = i; j + 1 < end; j++) if (b[j] === CR && b[j + 1] === LF) return j;

  return -1;
}

/** The decimal integer in `b[from..to)`. */
export function num(b: Uint8Array, from: number, to: number): number {
  let n = 0;
  let neg = false;
  let i = from;

  if (b[i] === 45) {
    neg = true;
    i++;
  }

  for (; i < to; i++) n = n * 10 + (b[i] - 48);

  return neg ? -n : n;
}

/** End offset of the RESP frame that starts at `i`, or -1 if `b[i..end)` holds only part of it. Pass the same
 *  `resume` while the frame at `i` arrives in pieces: an aggregate's elements already found complete aren't
 *  scanned again (offsets are relative to `i`, so the caller may move the frame). */
export function frameEnd(b: Uint8Array, i: number, end: number, resume: FrameResume | null = null): number {
  if (i >= end) return -1;
  const t = b[i];
  const le = lineEnd(b, i + 1, end);

  if (le < 0) return -1;

  switch (t) {
    case 43: // +
    case 45: // -
    case 58: // :
    case 95: // _
    case 35: // #
    case 44: // ,
    case 40: // (
      return le + 2;
    case 36: // $
    case 33: // !
    case 61: {
      // =
      const n = num(b, i + 1, le);

      if (n < 0) return le + 2;
      const e = le + 2 + n + 2;

      return e <= end ? e : -1;
    }

    case 42: // *
    case 126: // ~
    case 62: // >
    case 37: // %
    case 124: {
      // |
      let n = num(b, i + 1, le);

      if (n < 0) return le + 2;

      if (t === 37 || t === 124) n *= 2;

      // An attribute is followed by the reply it annotates: rare, so no resuming.
      if (t === 124) resume = null;
      let k = 0;
      let j = le + 2;

      if (resume?.k && resume.rel !== undefined) {
        k = resume.k;
        j = i + resume.rel;
      }

      for (; k < n; k++) {
        const e = frameEnd(b, j, end);

        if (e < 0) {
          if (resume) {
            resume.k = k;
            resume.rel = j - i;
          }

          return -1;
        }

        j = e;
      }

      if (resume) resume.k = 0;

      return t === 124 ? frameEnd(b, j, end) : j;
    }

    default:
      throw new Error(`RESP protocol error: unexpected byte ${t} at ${i}`);
  }
}

const toBytes = (x: CommandArg): Uint8Array => (x instanceof Uint8Array ? x : encoder.encode(String(x)));

/** Encodes one command (an array of bulk strings). */
export function command(args: readonly CommandArg[]): Uint8Array {
  const parts: Uint8Array[] = [encoder.encode(`*${args.length}\r\n`)];

  for (const a of args) {
    const b = toBytes(a);
    parts.push(encoder.encode(`$${b.length}\r\n`), b, CRLF);
  }

  return concat(parts);
}

export const simple = (s: string): Uint8Array => encoder.encode(`+${s}\r\n`);

// Newlines become spaces, as Valkey does: client text in an error must not end the frame early.
export const error = (s: string): Uint8Array => encoder.encode(`-${s.replace(/[\r\n]/g, " ")}\r\n`);
export const integer = (n: number | bigint): Uint8Array => encoder.encode(`:${n}\r\n`);

export function bulk(x: CommandArg | null): Uint8Array {
  if (x === null) return encoder.encode("$-1\r\n");
  const b = toBytes(x);

  return concat([encoder.encode(`$${b.length}\r\n`), b, CRLF]);
}

export const arrayOf = (frames: readonly Uint8Array[]): Uint8Array =>
  concat([encoder.encode(`*${frames.length}\r\n`), ...frames]);

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;

  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;

  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }

  return out;
}

/** Splits a reply array frame (`*n ...`) into its element frames. */
export function elements(frame: Uint8Array): Uint8Array[] {
  const le = lineEnd(frame, 1, frame.length);
  const n = num(frame, 1, le);
  const out = [];
  let j = le + 2;

  for (let k = 0; k < n; k++) {
    const e = frameEnd(frame, j, frame.length);
    out.push(frame.subarray(j, e));
    j = e;
  }

  return out;
}

export const str = (b: Uint8Array): string => decoder.decode(b);

// Apply, unlike spreading the bytes, keeps lower() as fast as a plain loop on command names.
const latin1: (thisArg: null, codes: Uint8Array) => string = Function.prototype.apply.bind(String.fromCharCode);

export const lower = (b: Uint8Array): string => (b.length <= 64 ? latin1(null, b) : decoder.decode(b)).toLowerCase();

export const EMPTY = new Uint8Array(0);
export const HELLO3 = command(["HELLO", "3"]);
