// Client requests: the one parser untrusted bytes go through.
import { lineEnd, num } from "./resp";
import type { ParsedRequest, RequestResume } from "./types";

const enc = new TextEncoder();
const dec = new TextDecoder();

// Valkey's PROTO_INLINE_MAX_SIZE.
const INLINE_MAX = 64 << 10;

function inline(b: Uint8Array, i: number, end: number, max: number): ParsedRequest | null {
  const le = lineEnd(b, i, end);

  if (le < 0) {
    if (end - i > Math.min(max, INLINE_MAX)) throw new Error("Protocol error: too big inline request");

    return null;
  }

  const argv = [];

  for (const word of dec.decode(b.subarray(i, le)).trim().split(/\s+/)) if (word) argv.push(enc.encode(word));

  return { argv, end: le + 2 };
}

function pause(resume: RequestResume | null, argv: Uint8Array[], k: number, rel: number): null {
  if (resume) {
    resume.argv = argv;
    resume.k = k;
    resume.rel = rel;
  }

  return null;
}

/**
 * Parses one client request at `i`: a RESP array of bulk strings, or an inline command. Returns null while it is
 * incomplete. Throws Valkey's protocol errors for a request over `max` bytes or an over-long line, so a client
 * can't make the caller buffer without bound. Pass the same `resume` while the request at `i` arrives in pieces,
 * so arguments already parsed aren't parsed again (a pipeline of 500k small ones arrives in hundreds of chunks).
 */
export function request(
  b: Uint8Array,
  i: number,
  end: number,
  max = Infinity,
  resume: RequestResume | null = null,
): ParsedRequest | null {
  if (i >= end) return null;

  if (b[i] !== 42) return inline(b, i, end, max);
  const le = lineEnd(b, i + 1, end);

  if (le < 0) {
    if (end - i > INLINE_MAX) throw new Error("Protocol error: too big mbulk count string");

    return null;
  }

  const n = num(b, i + 1, le);
  let argv: Uint8Array[] = [];
  let k = 0;
  let j = le + 2;

  if (resume?.argv && resume.k !== undefined && resume.rel !== undefined) {
    argv = resume.argv;
    k = resume.k;
    j = i + resume.rel;
  }

  for (; k < n; k++) {
    if (j >= end) return pause(resume, argv, k, j - i);

    if (b[j] !== 36) throw new Error("RESP protocol error: expected bulk string in request");
    const l = lineEnd(b, j + 1, end);

    if (l < 0) {
      if (end - j > INLINE_MAX) throw new Error("Protocol error: too big bulk count string");

      return pause(resume, argv, k, j - i);
    }

    const len = num(b, j + 1, l);

    if (len < 0 || l + 2 + len + 2 - i > max) throw new Error("Protocol error: invalid bulk length");

    if (l + 2 + len + 2 > end) return pause(resume, argv, k, j - i);
    argv.push(b.subarray(l + 2, l + 2 + len));
    j = l + 2 + len + 2;
  }

  if (resume) resume.argv = null;

  return { argv, end: j };
}
