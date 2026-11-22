import { expect, test } from "vite-plus/test";
import type { ShardReading } from "../types";
import { Shards } from "./shards";

const reading = (instance: string, version: string, reads: number, used = 10): ShardReading => ({
  i: 0,
  instance,
  version,
  isolate: "iso",
  colo: "LHR",
  city: "London",
  lat: 51.5,
  lon: -0.1,
  aliveSeconds: 1,
  keys: 0,
  memory: { used, max: 100, wasm: 0 },
  calls: { reads, writes: 0 },
  clients: 0,
  log: { base: 0, size: 0, rewriting: false, lastRewrite: null },
  replicas: [],
});

test("rates over polls, and a new instance on a new version is a deploy", () => {
  const shards = new Shards();
  shards.see([reading("a", "v1", 0)], 1000);
  const second = shards.see([reading("a", "v1", 10)], 2000);
  expect(second.shards[0]).toMatchObject({ ok: true, reads: 10, restartedAt: 0 });
  expect(second.shards[0]).not.toHaveProperty("instance");

  const third = shards.see([reading("b", "v2", 0)], 3000);
  expect(third.changes.restarts).toEqual([{ i: 0, deploy: true, backMs: null }]);
  expect(third.shards[0]).toMatchObject({ reads: 0, restartedAt: 3000 });
});

test("an asked-for restart says how long it took; a down shard keeps its place", () => {
  const shards = new Shards();
  shards.see([reading("a", "v1", 0)], 1000);
  shards.asked(0, 1500);
  const down = shards.see([{ i: 0, down: "gone" }], 2000);
  expect(down.alerts.map((e) => e.text)).toEqual(["Shard 0 stopped responding"]);
  expect(down.shards[0]).toMatchObject({ ok: false, error: "gone", city: "London" });
  expect(shards.see([{ i: 0, down: "gone" }], 2500).alerts).toEqual([]);
  expect(shards.see([reading("b", "v1", 0)], 4000).changes.restarts).toEqual([{ i: 0, deploy: false, backMs: 2500 }]);
});

test("memory warns once until it drops below the low mark", () => {
  const shards = new Shards();
  const alerts = [95, 96, 85, 95, 70, 92].map((used, k) => shards.see([reading("a", "v1", 0, used)], k * 1000).alerts);
  expect(alerts.map((a) => a.length)).toEqual([1, 0, 0, 0, 0, 1]);
});
