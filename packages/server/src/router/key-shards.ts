import { shardOfSlot, slotOf } from "../protocol/slots";
import type { UpKey } from "./types";

export const isPrimary = (key: UpKey): key is number => Number.isInteger(key);

/** The shard every key maps to, or -1 if they aren't all in one slot. */
export function shardOfKeys(keys: Uint8Array[], shards: number): number {
  const slot = slotOf(keys[0]);

  for (let k = 1; k < keys.length; k++) if (slotOf(keys[k]) !== slot) return -1;

  return shardOfSlot(slot, shards);
}

/** Like shardOfKeys, for the keys at argv[idx[0]], argv[idx[1]], ... (nonempty). */
export function shardAt(argv: Uint8Array[], idx: number[], shards: number): number {
  const slot = slotOf(argv[idx[0]]);

  for (let k = 1; k < idx.length; k++) if (slotOf(argv[idx[k]]) !== slot) return -1;

  return shardOfSlot(slot, shards);
}

/** Indexes of every `step`-th key, grouped by the shard its slot maps to. */
export function groupByShard(keys: Uint8Array[], shards: number, step = 1): Map<number, number[]> {
  const groups = new Map<number, number[]>();

  for (let i = 0; i < keys.length; i += step) {
    const shard = shardOfSlot(slotOf(keys[i]), shards);
    const list = groups.get(shard);

    if (list) list.push(i);
    else groups.set(shard, [i]);
  }

  return groups;
}
