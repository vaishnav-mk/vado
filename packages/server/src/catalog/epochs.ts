import * as v from "valibot";
import { SLOTS } from "../protocol/slots";
import type { Epoch } from "./types";

const RULE = `SHARD_EPOCHS entries need ascending integer \`from\` and 1..${SLOTS} \`shards\``;

const Epochs = v.pipe(
  v.array(
    v.object({
      from: v.pipe(v.number(), v.safeInteger()),
      shards: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(SLOTS)),
    }),
  ),
  v.check((list) => list.every((e, i) => i === 0 || e.from > list[i - 1].from)),
);

export function parseEpochs(raw: string | undefined): Epoch[] {
  if (!raw) return [{ from: 0, shards: 1 }];
  const parsed = v.safeParse(Epochs, JSON.parse(raw));

  if (!parsed.success) throw new Error(RULE);

  if (parsed.output[0]?.from !== 0) throw new Error("the first SHARD_EPOCHS entry must start at 0");

  return parsed.output;
}

export const epochAt = (epochs: Epoch[], time: number): Epoch =>
  epochs.reduce((found, e) => (e.from <= time ? e : found), epochs[0]);
