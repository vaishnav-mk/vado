import { expect, test } from "vite-plus/test";
import type { Replica, ShardUp } from "../../../src/admin/live-types";
import { buildState, keep, point, rate } from "../../../src/admin/watcher/state";
import type { Reading } from "../../../src/admin/watcher/types";
import { percentile } from "../../../src/shared";

test("keep holds the last n", () => {
  const xs = [1, 2, 3];
  expect(keep(xs, 4, 3)).toEqual([2, 3, 4]);
});

test("a percentile of nothing is null, and the input stays unsorted", () => {
  const xs = [5, 1, 3];

  expect(percentile([], 0.5)).toBe(null);
  expect(percentile(xs, 0.5)).toBe(3);
  expect(percentile(xs, 0.99)).toBe(5);
  expect(xs).toEqual([5, 1, 3]);
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
  probeAt: null,
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
  expect(s.probe).toEqual({ readMs: 4, writeMs: 6, writes: false, failed: 1, shard: null, replica: null });
  expect(point(s)).toEqual({ t: 100_000, reads: 11, writes: 4, replicaReads: 7, readMs: 4, writeMs: 6 });
});

test("health", () => {
  expect(buildState(reading({})).health).toBe("starting");
  expect(buildState(reading({ shards: [shard(0, 0)] })).health).toBe("healthy");
  expect(buildState(reading({ shards: [{ ...shard(0, 0), restartedAt: 95_000 }] })).health).toBe("restarting");
  expect(buildState(reading({ error: "no", shards: [shard(0, 0)] })).health).toBe("unreachable");
});

test("the probe names the replica that read only while it's ready, else the shard read", () => {
  const at = (state: Replica["state"]) =>
    buildState(reading({ shards: [shard(0, 1, [replica(state, 5, 0)])], probeAt: { shard: 0, replica: "weur" } }))
      .probe;

  expect(at("ready")).toMatchObject({ shard: 0, replica: "weur" });
  expect(at("asleep")).toMatchObject({ shard: 0, replica: null });
});
