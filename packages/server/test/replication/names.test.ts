import { expect, test } from "vite-plus/test";
import { shardName } from "../../src/catalog/placement";
import { isReplicaName, replicaBinding, replicaDial, replicaName, replicaOf } from "../../src/replication/names";
import { PongCounter } from "../../src/replication/wire";

const db = { name: "app", created: 1_700_000_000_000, flavour: "valkey" as const };

test("replica names, bindings and dials stay what old code expects", () => {
  expect(shardName(db, 3)).toBe("app.loyw3v28.3");
  expect(shardName({ ...db, flavour: "redis" }, "pubsub")).toBe("app.loyw3v28.redis.pubsub");
  expect(replicaName("app.loyw3v28.3", "weur")).toBe("app.loyw3v28.3.r.weur");
  expect(isReplicaName("app.loyw3v28.3.r.apac-ne")).toBe(true);
  expect(isReplicaName("app.loyw3v28.3")).toBe(false);
  expect(replicaBinding(0)).toBe("SHARD8");
  expect(replicaBinding(7)).toBe("SHARD15");
  expect(replicaDial(42)).toBe("repl-42:6379");

  const asked: [string, string][] = [];

  const namespace = {
    getByName: (name: string, options: { locationHint: string }) => asked.push([name, options.locationHint]),
  };

  replicaOf(namespace, "app.x.0", "oc");
  expect(asked).toEqual([["app.x.0.r.oc", "oc"]]);
});

test("PongCounter counts replies split anywhere", () => {
  const bytes = new TextEncoder().encode("+OK\r\n+PONG\r\n".repeat(5));

  for (const size of [1, 3, 7, bytes.length]) {
    const pongs = new PongCounter();
    let n = 0;

    for (let i = 0; i < bytes.length; i += size) n += pongs.count(bytes.subarray(i, i + size));
    expect(n, `in pieces of ${size}`).toBe(5);
  }
});
