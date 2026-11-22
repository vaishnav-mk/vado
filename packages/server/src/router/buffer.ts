// End of the bytes written into each buffer `append` allocated.
const written = new WeakMap<ArrayBufferLike, number>();

/**
 * Appends `b` to the unparsed tail `a`, growing into spare capacity (doubling), so a frame that arrives in many
 * chunks is copied O(size) times, not O(size²). It writes only past the last byte it wrote, into buffers it
 * allocated, so views already handed out (argv, frames) never change.
 */
export function append(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const end = a.byteOffset + a.length;

  if (written.get(a.buffer) === end && end + b.length <= a.buffer.byteLength) {
    new Uint8Array(a.buffer).set(b, end);
    written.set(a.buffer, end + b.length);

    return new Uint8Array(a.buffer, a.byteOffset, a.length + b.length);
  }

  // The first join is exact-size (the common split-frame case); doubling starts once a frame keeps growing.
  const n = a.length + b.length,
    out = new Uint8Array(written.has(a.buffer) ? 2 * n : n);

  out.set(a);
  out.set(b, a.length);
  written.set(out.buffer, n);

  return out.subarray(0, n);
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;

  return true;
}
