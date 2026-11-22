// RESP2/RESP3 on bytes: frame boundaries for proxying, decoding for admin paths, encoding.
const enc = new TextEncoder();
const dec = new TextDecoder();

const CR = 13;

function lineEnd(b, i, end) {
  for (let j = i; j + 1 < end; j++) if (b[j] === CR && b[j + 1] === 10) return j;
  return -1;
}

function num(b, from, to) {
  let n = 0, neg = false, i = from;
  if (b[i] === 45) { neg = true; i++; }
  for (; i < to; i++) n = n * 10 + (b[i] - 48);
  return neg ? -n : n;
}

/** End offset of the RESP frame that starts at `i`, or -1 if `b[i..end)` holds only part of it. Pass the same
 *  `resume` object while the frame at `i` arrives in pieces: an aggregate's elements already found complete
 *  aren't scanned again (offsets are kept relative to `i`, so the caller may move the frame). */
export function frameEnd(b, i, end, resume = null) {
  if (i >= end) return -1;
  const t = b[i];
  const le = lineEnd(b, i + 1, end);
  if (le < 0) return -1;
  switch (t) {
    case 43: case 45: case 58: case 95: case 35: case 44: case 40: // + - : _ # , (
      return le + 2;
    case 36: case 33: case 61: { // $ ! =
      const n = num(b, i + 1, le);
      if (n < 0) return le + 2;
      const e = le + 2 + n + 2;
      return e <= end ? e : -1;
    }
    case 42: case 126: case 62: case 37: case 124: { // * ~ > % |
      let n = num(b, i + 1, le);
      if (n < 0) return le + 2;
      if (t === 37 || t === 124) n *= 2;
      if (t === 124) resume = null; // an attribute is followed by the reply it annotates: rare, so no resuming
      let k = 0, j = le + 2;
      if (resume?.k) { k = resume.k; j = i + resume.rel; }
      for (; k < n; k++) {
        const e = frameEnd(b, j, end);
        if (e < 0) { if (resume) { resume.k = k; resume.rel = j - i; } return -1; }
        j = e;
      }
      if (resume) resume.k = 0;
      return t === 124 ? frameEnd(b, j, end) : j;
    }
    default:
      throw new Error(`RESP protocol error: unexpected byte ${t} at ${i}`);
  }
}

/** Decodes the frame at `i`. Bulk strings become strings unless `raw`; errors become { err }. */
export function decode(b, i = 0, raw = false) {
  const t = b[i];
  const le = lineEnd(b, i + 1, b.length);
  if (le < 0) throw new Error("incomplete RESP frame");
  const line = () => dec.decode(b.subarray(i + 1, le));
  switch (t) {
    case 43: return [line(), le + 2];
    case 45: return [{ err: line() }, le + 2];
    case 58: return [num(b, i + 1, le), le + 2];
    case 95: return [null, le + 2];
    case 35: return [b[i + 1] === 116, le + 2];
    case 44: return [Number(line()), le + 2];
    case 40: return [BigInt(line()), le + 2];
    case 36: case 33: case 61: {
      const n = num(b, i + 1, le);
      if (n < 0) return [null, le + 2];
      let s = b.subarray(le + 2, le + 2 + n);
      if (t === 61) s = s.subarray(4); // verbatim "txt:"
      const v = raw ? s.slice() : dec.decode(s);
      return [t === 33 ? { err: dec.decode(s) } : v, le + 4 + n];
    }
    case 42: case 126: case 62: {
      const n = num(b, i + 1, le);
      if (n < 0) return [null, le + 2];
      const out = [];
      let j = le + 2;
      for (let k = 0; k < n; k++) { const [v, nx] = decode(b, j, raw); out.push(v); j = nx; }
      return [out, j];
    }
    case 37: {
      const n = num(b, i + 1, le), out = new Map();
      let j = le + 2;
      for (let k = 0; k < n; k++) { const [kk, a] = decode(b, j, raw); const [v, c] = decode(b, a, raw); out.set(kk, v); j = c; }
      return [out, j];
    }
    case 124: return decode(b, skipAttr(b, i), raw); // drop the attribute, keep the reply
    default: throw new Error(`RESP protocol error: unexpected byte ${t}`);
  }
}

/** Decodes the RESP2 reply at `i` keeping its type, so it can be shown as valkey-cli does (a status reply OK unquoted,
 *  a bulk string "OK" quoted): { type: "status" | "error" | "integer" | "bulk", value }, { type: "nil" }, or
 *  { type: "array", value: [replies] }. */
export function decodeTyped(b, i = 0) {
  const t = b[i];
  const le = lineEnd(b, i + 1, b.length);
  if (le < 0) throw new Error("incomplete RESP frame");
  const line = () => dec.decode(b.subarray(i + 1, le));
  switch (t) {
    case 43: return [{ type: "status", value: line() }, le + 2];
    case 45: return [{ type: "error", value: line() }, le + 2];
    case 58: return [{ type: "integer", value: num(b, i + 1, le) }, le + 2];
    case 36: {
      const n = num(b, i + 1, le);
      return n < 0 ? [{ type: "nil" }, le + 2] : [{ type: "bulk", value: dec.decode(b.subarray(le + 2, le + 2 + n)) }, le + 4 + n];
    }
    case 42: {
      const n = num(b, i + 1, le);
      if (n < 0) return [{ type: "nil" }, le + 2];
      const value = [];
      let j = le + 2;
      for (let k = 0; k < n; k++) { const [v, nx] = decodeTyped(b, j); value.push(v); j = nx; }
      return [{ type: "array", value }, j];
    }
    default: throw new Error(`RESP protocol error: unexpected byte ${t} in a RESP2 reply`);
  }
}

function skipAttr(b, i) {
  const le = lineEnd(b, i + 1, b.length);
  let j = le + 2;
  const n = num(b, i + 1, le) * 2;
  for (let k = 0; k < n; k++) j = frameEnd(b, j, b.length);
  return j;
}

export const decodeAll = (b) => { const out = []; for (let i = 0; i < b.length; ) { const [v, n] = decode(b, i); out.push(v); i = n; } return out; };

const toBytes = (x) => (x instanceof Uint8Array ? x : enc.encode(String(x)));

/** Encodes one command (array of bulk strings). */
export function command(args) {
  const parts = [enc.encode(`*${args.length}\r\n`)];
  for (const a of args) { const b = toBytes(a); parts.push(enc.encode(`$${b.length}\r\n`), b, CRLF); }
  return concat(parts);
}

const CRLF = enc.encode("\r\n");
export const simple = (s) => enc.encode(`+${s}\r\n`);
// Newlines become spaces, as Valkey does: client text in an error must not end the frame early.
export const error = (s) => enc.encode(`-${s.replace(/[\r\n]/g, " ")}\r\n`);
export const integer = (n) => enc.encode(`:${n}\r\n`);
export const bulk = (b) => (b === null ? enc.encode("$-1\r\n") : concat([enc.encode(`$${toBytes(b).length}\r\n`), toBytes(b), CRLF]));
export const arrayOf = (frames) => concat([enc.encode(`*${frames.length}\r\n`), ...frames]);

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Splits a reply array frame (`*n ...`) into its element frames. */
export function elements(frame) {
  const le = lineEnd(frame, 1, frame.length);
  const n = num(frame, 1, le);
  const out = [];
  let j = le + 2;
  for (let k = 0; k < n; k++) { const e = frameEnd(frame, j, frame.length); out.push(frame.subarray(j, e)); j = e; }
  return out;
}

const INLINE_MAX = 64 << 10; // Valkey's PROTO_INLINE_MAX_SIZE

/**
 * Parses one client request at `i`: a RESP array of bulk strings, or an inline command.
 * Returns { argv: Uint8Array[], end } or null when incomplete. Throws Valkey's protocol errors for a
 * request over `max` bytes or an over-long line, so a client can't make the caller buffer unboundedly.
 * Pass the same `resume` object while the request at `i` arrives in pieces, so the arguments already parsed
 * aren't parsed again (a pipeline of 500k small ones arrives in hundreds of chunks).
 */
export function request(b, i, end, max = Infinity, resume = null) {
  if (i >= end) return null;
  if (b[i] !== 42) {
    const le = lineEnd(b, i, end);
    if (le < 0) { if (end - i > Math.min(max, INLINE_MAX)) throw new Error("Protocol error: too big inline request"); return null; }
    const words = dec.decode(b.subarray(i, le)).trim().split(/\s+/).filter(Boolean).map((w) => enc.encode(w));
    return { argv: words, end: le + 2 };
  }
  const le = lineEnd(b, i + 1, end);
  if (le < 0) { if (end - i > INLINE_MAX) throw new Error("Protocol error: too big mbulk count string"); return null; }
  const n = num(b, i + 1, le);
  let argv = [], k = 0, j = le + 2;
  if (resume?.argv) { ({ argv, k } = resume); j = i + resume.rel; }
  const wait = () => { if (resume) Object.assign(resume, { argv, k, rel: j - i }); return null; };
  for (; k < n; k++) {
    if (j >= end) return wait();
    if (b[j] !== 36) throw new Error("RESP protocol error: expected bulk string in request");
    const l = lineEnd(b, j + 1, end);
    if (l < 0) { if (end - j > INLINE_MAX) throw new Error("Protocol error: too big bulk count string"); return wait(); }
    const len = num(b, j + 1, l);
    if (len < 0 || l + 2 + len + 2 - i > max) throw new Error("Protocol error: invalid bulk length");
    if (l + 2 + len + 2 > end) return wait();
    argv.push(b.subarray(l + 2, l + 2 + len));
    j = l + 2 + len + 2;
  }
  if (resume) resume.argv = null;
  return { argv, end: j };
}

export const str = (b) => dec.decode(b);
export const lower = (b) => (b.length <= 64 ? String.fromCharCode.apply(null, b) : dec.decode(b)).toLowerCase();
