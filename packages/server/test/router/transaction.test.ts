import { expect, test } from "vite-plus/test";
import { shardOfSlot, slotOf } from "../../src/protocol/slots";
import { CROSSSLOT, EXECABORT } from "../../src/router/replies-text";
import { client, fakeShard } from "./fake-shard";

const enc = new TextEncoder(),
  dec = new TextDecoder();

const shardOf = (k: string) => shardOfSlot(slotOf(enc.encode(k)), 2);

test("an EXEC the router aborts unwatches the shard, so that socket's next transaction isn't watched", async () => {
  const shards = [0, 1].map(() => fakeShard(() => "+OK\r\n"));

  const mine = "a",
    other = ["b", "c", "d", "e", "f"].find((k) => shardOf(k) !== shardOf(mine)) ?? "";

  expect(other, "a key on the other shard").not.toBe("");

  const c = client(
    shards.map((s) => s.stub),
    shards[0].stub,
  );

  for (const cmd of [["WATCH", mine], ["MULTI"], ["SET", mine, "1"], ["SET", other, "1"], ["EXEC"]])
    await c.call(...cmd);

  const want = `+OK\r\n+OK\r\n+QUEUED\r\n${dec.decode(CROSSSLOT)}${dec.decode(EXECABORT)}`;
  expect(await c.read(want.length)).toBe(want);

  const watched = shards[shardOf(mine)];

  for (let i = 0; i < 50 && watched.got.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  await c.close();

  expect(watched.got).toEqual([["WATCH", mine], ["UNWATCH"]]);
  expect(shards[shardOf(other)].got).toEqual([]);
});
