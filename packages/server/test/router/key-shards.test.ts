import { expect, test } from "vite-plus/test";
import { shardOfSlot, slotOf } from "../../src/protocol/slots";
import { groupByShard, shardAt, shardOfKeys } from "../../src/router/key-shards";
import { isPrimary } from "../../src/router/upstream";

const enc = new TextEncoder();
const keys = (...names: string[]) => names.map((n) => enc.encode(n));
const shardOf = (name: string, shards: number) => shardOfSlot(slotOf(enc.encode(name)), shards);

test("keys sharing a hash tag go to one shard; others may not", () => {
  expect(shardOfKeys(keys("{u1}a", "{u1}b", "{u1}c"), 8)).toBe(shardOf("u1", 8));
  expect(shardOfKeys(keys("a", "b"), 8), "different slots, even on one shard").toBe(-1);
  expect(shardAt(keys("SET", "{u1}a", "v", "{u1}b"), [1, 3], 8)).toBe(shardOf("u1", 8));
  expect(shardAt(keys("MSET", "a", "v", "b"), [1, 3], 8)).toBe(-1);
});

test("groupByShard keeps each key's index, in order, per shard", () => {
  const names = ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"],
    groups = groupByShard(keys(...names), 4);

  const seen = [...groups.values()].flat().sort((a, b) => a - b);
  expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

  for (const [shard, idx] of groups) {
    expect(idx).toEqual([...idx].sort((a, b) => a - b));

    for (const i of idx) expect(shardOf(names[i], 4)).toBe(shard);
  }
});

test("groupByShard with step 2 groups MSET pairs by their key", () => {
  const args = keys("{a}1", "v1", "{b}1", "v2", "{a}2", "v3"),
    groups = groupByShard(args, 16, 2);

  expect(groups.get(shardOf("a", 16))).toEqual(shardOf("a", 16) === shardOf("b", 16) ? [0, 2, 4] : [0, 4]);
  expect([...groups.values()].flat().sort((a, b) => a - b)).toEqual([0, 2, 4]);
});

test("only shard indexes are primaries", () => {
  expect(isPrimary(0)).toBe(true);
  expect(isPrimary(7)).toBe(true);
  expect(isPrimary("pubsub")).toBe(false);
  expect(isPrimary("r3")).toBe(false);
});
