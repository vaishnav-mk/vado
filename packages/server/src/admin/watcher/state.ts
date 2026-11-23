import { RESTARTING_MS } from "../config";
import type { Database, Entry, Health, LiveState, Place, Point, Shard, TestView } from "../live-types";

export type ProbeSample = { readMs: number; writeMs: number | null } | { failed: true };

export interface Reading {
  at: number;
  error: string | null;
  db: Database | null;
  watcher: Place | null;
  shards: Shard[];
  entries: Entry[];
  probes: ProbeSample[];
  writes: boolean;
  test: TestView | null;
}

export const median = (xs: number[]): number | null =>
  xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : null;

export function keep<T>(xs: T[], x: T, n: number): T[] {
  xs.push(x);

  if (xs.length > n) xs.splice(0, xs.length - n);

  return xs;
}

export function rate<K extends string>(points: ({ at: number } & Record<K, number>)[], key: K): number {
  const first = points[0],
    last = points.at(-1);

  if (!first || !last || last.at === first.at) return 0;

  return Math.max(0, (last[key] - first[key]) / ((last.at - first.at) / 1000));
}

function health(r: Reading, restarting: number): Health {
  if (r.error) return "unreachable";

  if (restarting) return "restarting";

  return r.shards.length ? "healthy" : "starting";
}

export function buildState(r: Reading): LiveState {
  const up = r.shards.flatMap((s) => (s.ok ? [s] : []));
  const sum = (f: (s: (typeof up)[number]) => number) => up.reduce((a, s) => a + f(s), 0);
  const restarting = r.shards.filter((s) => !s.ok || r.at - s.restartedAt < RESTARTING_MS).length;
  const replicas = r.shards.flatMap((s) => s.replicas);
  const ready = replicas.filter((x) => x.state === "ready");
  const measured = r.probes.flatMap((p) => ("failed" in p ? [] : [p]));

  return {
    at: r.at,
    error: r.error,
    db: r.db,
    watcher: r.watcher,
    health: health(r, restarting),
    restarting,
    totals: {
      reads: sum((s) => s.reads),
      writes: sum((s) => s.writes),
      replicaReads: sum((s) => s.replicas.reduce((a, x) => a + x.reads, 0)),
      keys: sum((s) => s.keys),
      memory: sum((s) => s.memory.used),
      maxMemory: sum((s) => s.memory.max),
      logBytes: sum((s) => s.log.size),
      replicas: replicas.length,
      replicasReady: ready.length,
      replicaLagMs: Math.max(0, ...ready.map((x) => x.lagMs ?? 0)),
    },
    probe: {
      readMs: median(measured.map((p) => p.readMs)),
      writeMs: median(measured.flatMap((p) => (p.writeMs === null ? [] : [p.writeMs]))),
      writes: r.writes,
      failed: r.probes.length - measured.length,
    },
    shards: r.shards,
    map: { entries: r.entries },
    test: r.test,
  };
}

// A tenth is enough, and keeps small rates from rounding to zero.
const tenth = (x: number) => Math.round(x * 10) / 10;

export const point = (s: LiveState): Point => ({
  t: s.at,
  reads: tenth(s.totals.reads + s.totals.replicaReads),
  writes: tenth(s.totals.writes),
  replicaReads: tenth(s.totals.replicaReads),
  readMs: s.probe.readMs,
  writeMs: s.probe.writeMs,
});
