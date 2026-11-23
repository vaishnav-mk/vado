import { shardOfSlot, slotOf } from "../protocol/slots";
import type { UpKey } from "./types";

export const isPrimary = (key: UpKey): key is number => Number.isInteger(key);

// -1 if the keys at argv[idx[...]] aren't all in one slot.
export function shardAt(argv: Uint8Array[], idx: number[], shards: number): number {
  if (!idx.length || shards === 1) return 0;
  const slot = slotOf(argv[idx[0]]);

  for (let k = 1; k < idx.length; k++) if (slotOf(argv[idx[k]]) !== slot) return -1;

  return shardOfSlot(slot, shards);
}

export const shardOfKeys = (keys: Uint8Array[], shards: number): number =>
  shardAt(
    keys,
    keys.map((_, i) => i),
    shards,
  );

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
