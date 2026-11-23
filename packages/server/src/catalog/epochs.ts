import { SLOTS } from "../protocol/slots";
import type { Epoch } from "./types";

const RULE = "SHARD_EPOCHS entries need ascending integer `from` and 1..16384 `shards`";

function isEpoch(e: unknown): e is Epoch {
  return (
    e instanceof Object &&
    "from" in e &&
    "shards" in e &&
    Number.isSafeInteger(e.from) &&
    Number.isSafeInteger(e.shards)
  );
}

export function parseEpochs(raw: string | undefined): Epoch[] {
  if (!raw) return [{ from: 0, shards: 1 }];
  const list: unknown = JSON.parse(raw);

  if (!Array.isArray(list)) throw new Error(RULE);
  const epochs: Epoch[] = [];
  let prev = -1;

  for (const e of list) {
    if (!isEpoch(e) || e.from <= prev || e.shards < 1 || e.shards > SLOTS) throw new Error(RULE);
    epochs.push({ from: e.from, shards: e.shards });
    prev = e.from;
  }

  if (epochs[0]?.from !== 0) throw new Error("the first SHARD_EPOCHS entry must start at 0");

  return epochs;
}

export const epochAt = (epochs: Epoch[], time: number): Epoch =>
  epochs.reduce((found, e) => (e.from <= time ? e : found), epochs[0]);
