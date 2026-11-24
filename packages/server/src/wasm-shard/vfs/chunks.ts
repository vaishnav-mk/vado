import type { ChunkRow } from "./types";

export function rowAt(rows: ChunkRow[], pos: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  let found = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;

    if (rows[mid].start <= pos) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }

  return found;
}

export function indexRows(list: { seq: number; len: number }[]): ChunkRow[] {
  let start = 0;

  return list.map(({ seq, len }) => {
    const row = { seq, start, len };
    start += len;

    return row;
  });
}
