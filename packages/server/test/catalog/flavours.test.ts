import { describe, expect, test } from "vite-plus/test";
import { flavourOf, FLAVOURS, isFlavour, isNative, serverOf } from "../../src/catalog/flavours";
import { shardName } from "../../src/catalog/placement";
import { replicaName } from "../../src/wasm-shard/replication/names";

describe("flavours", () => {
  test("every object knows its flavour from its name", () => {
    for (const flavour of FLAVOURS) {
      const shard = shardName({ name: "redis", created: 1_700_000_000_000, flavour }, 3);

      expect(flavourOf(shard)).toBe(flavour);
      expect(flavourOf(shardName({ name: "db", created: 1, flavour }, "pubsub"))).toBe(flavour);

      if (!isNative(flavour)) expect(flavourOf(replicaName(shard, "weur"))).toBe(flavour);
    }
  });

  test("server and placement of each flavour", () => {
    expect(FLAVOURS.map(serverOf)).toEqual(["valkey", "valkey", "redis", "redis"]);
    expect(FLAVOURS.map(isNative)).toEqual([false, true, false, true]);
    expect([isFlavour("redis-native"), isFlavour("native"), isFlavour(null)]).toEqual([true, false, false]);
  });
});
