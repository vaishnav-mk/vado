import { expect, test } from "vite-plus/test";
import type { Replica, ShardUp } from "../live-types";
import { buildState, keep, median, point, rate, type Reading } from "./state";

test("keep holds the last n", () => {
  const xs = [1, 2, 3];
  expect(keep(xs, 4, 3)).toEqual([2, 3, 4]);
});

test("median of nothing is null", () => {
  expect(median([])).toBe(null);
  expect(median([5, 1, 3])).toBe(3);
});

test("rate is per second between the oldest and newest point, never negative", () => {
  expect(rate([], "reads")).toBe(0);
  expect(rate([{ at: 1000, reads: 5 }], "reads")).toBe(0);
  expect(
    rate(
      [
        { at: 1000, reads: 0 },
        { at: 1500, reads: 1 },
        { at: 3000, reads: 10 },
      ],
      "reads",
    ),
  ).toBe(5);
  expect(
    rate(
      [
        { at: 0, reads: 10 },
        { at: 1000, reads: 0 },
      ],
      "reads",
    ),
  ).toBe(0);
});

const replica = (state: Replica["state"], lagMs: number, reads: number): Replica => ({
  region: "weur",
  regionName: "Western Europe",
  state,
  lagMs,
  behindBytes: 0,
  error: null,
  reads,
  colo: null,
  city: null,
  lat: null,
  lon: null,
});

const shard = (i: number, reads: number, replicas: Replica[] = []): ShardUp => ({
  i,
  ok: true,
  version: "v1",
  isolate: "iso",
  colo: null,
  city: null,
  lat: null,
  lon: null,
  aliveSeconds: 100,
  keys: 10,
  memory: { used: 100, max: 1000, wasm: 200 },
  clients: 1,
  log: { base: 0, size: 50, rewriting: false, lastRewrite: null },
  replicas,
  reads,
  writes: 2,
  restartedAt: 0,
});

const reading = (r: Partial<Reading>): Reading => ({
  at: 100_000,
  error: null,
  db: null,
  watcher: null,
  shards: [],
  entries: [],
  probes: [],
  writes: false,
  test: null,
  ...r,
});

test("totals add up the shards that answered, and replica lag is the worst ready one", () => {
  const s = buildState(
    reading({
      shards: [
        shard(0, 3, [replica("ready", 40, 7), replica("copying", 900, 0)]),
        shard(1, 1.04),
        { i: 2, ok: false, error: "gone", colo: null, city: null, lat: null, lon: null, restartedAt: 0, replicas: [] },
      ],
      probes: [{ readMs: 2, writeMs: null }, { failed: true }, { readMs: 4, writeMs: 6 }],
    }),
  );

  expect(s.health).toBe("restarting");
  expect(s.restarting).toBe(1);
  expect(s.totals).toMatchObject({ reads: 4.04, writes: 4, replicaReads: 7, keys: 20, replicas: 2, replicasReady: 1 });
  expect(s.totals.replicaLagMs).toBe(40);
  expect(s.probe).toEqual({ readMs: 4, writeMs: 6, writes: false, failed: 1 });
  expect(point(s)).toEqual({ t: 100_000, reads: 11, writes: 4, replicaReads: 7, readMs: 4, writeMs: 6 });
});

test("health", () => {
  expect(buildState(reading({})).health).toBe("starting");
  expect(buildState(reading({ shards: [shard(0, 0)] })).health).toBe("healthy");
  expect(buildState(reading({ shards: [{ ...shard(0, 0), restartedAt: 95_000 }] })).health).toBe("restarting");
  expect(buildState(reading({ error: "no", shards: [shard(0, 0)] })).health).toBe("unreachable");
});
