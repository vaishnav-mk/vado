import { MEMORY_HIGH, MEMORY_OK, WATCH_RATE_POLLS } from "../config";
import type { Place, Replica, ReplicaState, Shard, ShardDown } from "../live-types";
import type { ShardReading, ShardSeen } from "../types";
import type { Changes, EventInput } from "./types";
import { keep, rate } from "./state";
import { place } from "../views";

interface TrackedReplica {
  state: ReplicaState | null;
  instance: string | null;
  points: { at: number; reads: number }[];
}

interface Tracked {
  points: { at: number; reads: number; writes: number }[];
  replicas: Map<string, TrackedReplica>;
  down: boolean;
  instance: string | null;
  version: string | null;
  place: Place;
  restartedAt: number;
  memoryHigh: boolean;
  rewriteAt: number | undefined; // undefined: none seen yet
}

export interface Look {
  shards: Shard[];
  changes: Changes;
  alerts: EventInput[];
}

const NOWHERE = place(null);

export class Shards {
  #tracked = new Map<number, Tracked>();
  #asked = new Map<number, number>(); // when the dashboard asked each shard to restart

  get size(): number {
    return this.#tracked.size;
  }

  asked(i: number, at = Date.now()): void {
    this.#asked.set(i, at);
  }

  // Shards may restart while nobody watches: start over rather than report restarts and rates from then.
  clear(): void {
    this.#tracked.clear();
  }

  see(views: ShardSeen[], at: number): Look {
    const look: Look = { shards: [], changes: { restarts: [], replicas: [], rewrites: [] }, alerts: [] };

    for (const v of views) look.shards.push(this.#see(v, at, look));

    return look;
  }

  #see(v: ShardSeen, at: number, look: Look): Shard {
    let k = this.#tracked.get(v.i);

    if (!k) {
      k = {
        points: [],
        replicas: new Map(),
        down: false,
        instance: null,
        version: null,
        place: NOWHERE,
        restartedAt: 0,
        memoryHigh: false,
        rewriteAt: undefined,
      };
      this.#tracked.set(v.i, k);
    }

    if ("down" in v) {
      if (!k.down)
        look.alerts.push({ level: "warning", kind: "restart", text: `Shard ${v.i} stopped responding`, shard: v.i });
      k.down = true;

      const down: ShardDown = {
        i: v.i,
        ok: false,
        error: v.down,
        ...k.place,
        restartedAt: k.restartedAt,
        replicas: [],
      };

      return down;
    }

    if (k.instance && k.instance !== v.instance) {
      const asked = this.#asked.get(v.i);
      this.#asked.delete(v.i);
      look.changes.restarts.push({
        i: v.i,
        deploy: !!(k.version && v.version && k.version !== v.version),
        backMs: asked === undefined ? null : at - asked,
      });
      k.restartedAt = at;
      k.points = [];
    }

    k.down = false;
    k.instance = v.instance;
    k.version = v.version;
    k.place = { colo: v.colo, city: v.city, lat: v.lat, lon: v.lon };
    keep(k.points, { at, ...v.calls }, WATCH_RATE_POLLS);
    this.#memory(k, v, look);
    this.#rewrite(k, v, look);

    const { instance: _instance, calls: _calls, replicas, ...shown } = v;

    return {
      ...shown,
      ok: true,
      reads: rate(k.points, "reads"),
      writes: rate(k.points, "writes"),
      restartedAt: k.restartedAt,
      replicas: replicas.map((r) => this.#replica(k, v.i, r, at, look)),
    };
  }

  #memory(k: Tracked, v: ShardReading, look: Look): void {
    const used = v.memory.max ? v.memory.used / v.memory.max : 0;

    if (used >= MEMORY_HIGH && !k.memoryHigh)
      look.alerts.push({
        level: "warning",
        kind: "memory",
        text: `Shard ${v.i} is at ${Math.round(used * 100)}% of its memory`,
        shard: v.i,
      });

    if (used >= MEMORY_HIGH) k.memoryHigh = true;
    else if (used < MEMORY_OK) k.memoryHigh = false;
  }

  #rewrite(k: Tracked, v: ShardReading, look: Look): void {
    const last = v.log.lastRewrite;

    if (last?.ms === undefined || k.rewriteAt === last.at) return;

    if (k.rewriteAt !== undefined)
      look.changes.rewrites.push({ i: v.i, ms: last.ms, bytes: last.baseBytes ?? null, error: last.error ?? null });
    k.rewriteAt = last.at;
  }

  #replica(k: Tracked, i: number, r: ShardReading["replicas"][number], at: number, look: Look): Replica {
    let rk = k.replicas.get(r.region);

    if (!rk) {
      rk = { state: null, instance: null, points: [] };
      k.replicas.set(r.region, rk);
    }

    if (rk.state && rk.state !== r.state)
      look.changes.replicas.push({ i, region: r.region, from: rk.state, to: r.state, error: r.error });

    if (rk.instance !== r.instance) rk.points = [];
    rk.state = r.state;
    rk.instance = r.instance;

    if (r.instance) keep(rk.points, { at, reads: r.reads }, WATCH_RATE_POLLS);
    const { instance: _instance, ...shown } = r;

    return { ...shown, reads: r.instance ? rate(rk.points, "reads") : 0 };
  }
}
