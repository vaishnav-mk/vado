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

export function pushRow(rows: ChunkRow[], seq: number, len: number): void {
  const last = rows.at(-1);
  rows.push({ seq, start: last ? last.start + last.len : 0, len });
}

export function growLastRow(rows: ChunkRow[], seq: number, len: number): boolean {
  const last = rows.at(-1);

  if (last?.seq !== seq) return false;
  last.len = len;

  return true;
}
