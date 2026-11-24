import { expect, test } from "vite-plus/test";
import { shardOfSlot, slotOf } from "../../src/protocol/slots";
import { bulkOf, client, fakeShard } from "./fake-shard";

const enc = new TextEncoder();

test("a cross-slot MGET asks each shard for its keys and answers in the client's order", async () => {
  const shards = [0, 1].map((i) =>
    fakeShard(([, ...keys]) => `*${keys.length}\r\n${keys.map((k) => bulkOf(`${k}@${i}`)).join("")}`),
  );

  const keys = ["a", "b", "c", "d"],
    shardOf = (k: string) => shardOfSlot(slotOf(enc.encode(k)), 2);

  expect(new Set(keys.map(shardOf)).size, "the keys span both shards").toBe(2);

  const c = client(
    shards.map((s) => s.stub),
    shards[0].stub,
  );

  await c.call("MGET", ...keys);
  const want = `*4\r\n${keys.map((k) => bulkOf(`${k}@${shardOf(k)}`)).join("")}`;
  expect(await c.read(want.length)).toBe(want);

  for (const [i, s] of shards.entries()) expect(s.got).toEqual([["MGET", ...keys.filter((k) => shardOf(k) === i)]]);
  await c.close();
});
