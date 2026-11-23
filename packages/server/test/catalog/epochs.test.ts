import { expect, test } from "vite-plus/test";
import { epochAt, parseEpochs } from "../../src/catalog/epochs";
import { DB_NAME } from "../../src/catalog/names";

test("parseEpochs defaults to one shard and rejects bad lists", () => {
  expect(parseEpochs(undefined)).toEqual([{ from: 0, shards: 1 }]);
  expect(parseEpochs('[{"from":0,"shards":4},{"from":100,"shards":16}]')).toEqual([
    { from: 0, shards: 4 },
    { from: 100, shards: 16 },
  ]);

  for (const bad of [
    '[{"from":0,"shards":0}]',
    '[{"from":0,"shards":16385}]',
    '[{"from":0,"shards":2},{"from":0,"shards":3}]',
    '[{"from":0,"shards":1.5}]',
    '[{"from":"0","shards":1}]',
    "[1]",
    '{"from":0}',
  ])
    expect(() => parseEpochs(bad), bad).toThrow(/SHARD_EPOCHS/);
  expect(() => parseEpochs('[{"from":5,"shards":1}]')).toThrow(/start at 0/);
  expect(() => parseEpochs("[]")).toThrow(/start at 0/);
});

test("epochAt picks the latest epoch started by then", () => {
  const epochs = parseEpochs('[{"from":0,"shards":1},{"from":100,"shards":8},{"from":200,"shards":16}]');
  expect(epochAt(epochs, 0).shards).toBe(1);
  expect(epochAt(epochs, 99).shards).toBe(1);
  expect(epochAt(epochs, 100).shards).toBe(8);
  expect(epochAt(epochs, 1e12).shards).toBe(16);
});

test("database names", () => {
  for (const ok of ["a", "0db", "my_db-2", "x".repeat(63)]) expect(DB_NAME.test(ok), ok).toBe(true);

  for (const bad of ["", "-a", "_a", "A", "a.b", "a b", "x".repeat(64), "a.r.weur"])
    expect(DB_NAME.test(bad), bad).toBe(false);
});
