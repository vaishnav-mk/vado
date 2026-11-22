import { REGION_NAMES } from "../../replication/regions";
import { EVENT_REPEAT_MS, EVENTS_KEPT } from "../config";
import type { EventKind, EventLevel, LiveEvent } from "../live-types";

export interface EventInput {
  level: EventLevel;
  kind: EventKind;
  text: string;
  shard?: number;
  region?: string;
}

export interface Restart {
  i: number;
  deploy: boolean;
  backMs: number | null;
}

export interface ReplicaChange {
  i: number;
  region: string;
  from: string;
  to: string;
  error: string | null;
}

export interface Rewrite {
  i: number;
  ms: number;
  bytes: number | null;
  error: string | null;
}

/** What changed across a database's shards in one poll. */
export interface Changes {
  restarts: Restart[];
  replicas: ReplicaChange[];
  rewrites: Rewrite[];
}

/** The timeline, newest first. The same text again within EVENT_REPEAT_MS counts up (same id, a later t). */
export class EventLog {
  readonly events: LiveEvent[] = [];
  #fresh: LiveEvent[] = [];
  // From the clock, so ids stay unique across Watcher restarts: the page merges events by id.
  #seq = Date.now();

  add(e: EventInput, t = Date.now()): void {
    const last = this.events[0];

    if (last && last.text === e.text && t - last.t < EVENT_REPEAT_MS) {
      last.count++;
      last.t = t;
      this.#fresh.push(last);

      return;
    }

    const added = { id: ++this.#seq, t, ...e, count: 1 };
    this.events.unshift(added);

    if (this.events.length > EVENTS_KEPT) this.events.pop();
    this.#fresh.push(added);
  }

  /** The events added or counted up since the last call. */
  fresh(): LiveEvent[] {
    const out = this.#fresh;
    this.#fresh = [];

    return out;
  }
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

const size = (b: number) =>
  b < 2 ** 20 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 2 ** 20).toFixed(1)} MB`;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function restarts(all: Restart[], shardCount: number): EventInput[] {
  const deploys = all.filter((r) => r.deploy);
  const out: EventInput[] = [];

  if (deploys.length)
    out.push({
      level: "info",
      kind: "deploy",
      text:
        deploys.length === shardCount && deploys.length > 1
          ? `All ${deploys.length} shards restarted for a new deploy`
          : `${deploys.length === 1 ? `Shard ${deploys[0].i}` : plural(deploys.length, "shard")} restarted for a new deploy`,
    });

  for (const r of all)
    if (!r.deploy)
      out.push({
        level: "warning",
        kind: "restart",
        text:
          r.backMs === null ? `Shard ${r.i} restarted` : `Shard ${r.i} restarted and was back in ${seconds(r.backMs)}`,
        shard: r.i,
      });

  return out;
}

function rewrites(all: Rewrite[]): EventInput[] {
  const out: EventInput[] = [];
  const done = all.filter((r) => !r.error);

  for (const r of all)
    if (r.error)
      out.push({
        level: "warning",
        kind: "rewrite",
        text: `Shard ${r.i} couldn't compact its log in a helper, so it did it itself`,
        shard: r.i,
      });

  if (done.length === 1) {
    const [r] = done;
    out.push({
      level: "success",
      kind: "rewrite",
      text: `Shard ${r.i} compacted its log in ${seconds(r.ms)}${r.bytes ? `, to ${size(r.bytes)}` : ""}`,
      shard: r.i,
    });
  } else if (done.length)
    out.push({
      level: "success",
      kind: "rewrite",
      text: `${plural(done.length, "shard")} compacted their logs, the slowest in ${seconds(Math.max(...done.map((r) => r.ms)))}`,
    });

  return out;
}

const replicaOf = (r: ReplicaChange) => `The replica of shard ${r.i} in ${REGION_NAMES[r.region] ?? r.region}`;

// Each group of replica changes: which ones, its level, and its text for many or for one.
const REPLICA_GROUPS: {
  pick: (r: ReplicaChange) => boolean;
  level: EventLevel;
  many: (n: number) => string;
  one: (r: ReplicaChange) => string;
}[] = [
  {
    pick: (r) => r.to === "asleep",
    level: "info",
    many: (n) => `${plural(n, "replica")} went to sleep: no traffic for 10 minutes`,
    one: (r) => `${replicaOf(r)} went to sleep: no traffic for 10 minutes`,
  },
  {
    pick: (r) => r.to === "copying" && r.from === "asleep",
    level: "info",
    many: (n) => `New traffic woke ${plural(n, "replica")}; they're copying their shards`,
    one: (r) => `New traffic woke ${replicaOf(r).toLowerCase()}`,
  },
  {
    pick: (r) => r.to === "copying" && r.from !== "asleep",
    level: "info",
    many: (n) => `${plural(n, "replica")} started copying their shards`,
    one: (r) => `${replicaOf(r)} started copying its shard`,
  },
  {
    pick: (r) => r.to === "ready",
    level: "success",
    many: (n) => `${plural(n, "replica")} are ready and serving reads`,
    one: (r) => `${replicaOf(r)} is ready and serving reads`,
  },
  {
    pick: (r) => r.to === "idle",
    level: "warning",
    many: (n) => `${plural(n, "replica")} lost their stream and will copy again`,
    one: (r) => `${replicaOf(r)} lost its stream${r.error ? ` (${r.error})` : ""} and will copy again`,
  },
];

function replicas(all: ReplicaChange[]): EventInput[] {
  return REPLICA_GROUPS.flatMap(({ pick, level, many, one }): EventInput[] => {
    const xs = all.filter(pick);

    if (xs.length > 1) return [{ level, kind: "replica", text: many(xs.length) }];

    return xs.map((r) => ({ level, kind: "replica", text: one(r), shard: r.i, region: r.region }));
  });
}

/** One poll's changes as a few readable events rather than one per shard (a new database's shards all compact at
 *  once, say). */
export const summarize = (changes: Changes, shardCount: number): EventInput[] => [
  ...restarts(changes.restarts, shardCount),
  ...rewrites(changes.rewrites),
  ...replicas(changes.replicas),
];
