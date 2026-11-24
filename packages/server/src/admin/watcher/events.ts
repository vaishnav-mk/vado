import { regionName } from "../../catalog/regions";
import { EVENT_REPEAT_MS, EVENTS_KEPT } from "../config";
import type { EventLevel, LiveEvent } from "../live-types";
import { bytes, ms, plural } from "../../format";
import { REPL_IDLE_MS } from "../../wasm-shard/replication/config";
import type { EventInput, Restart, ReplicaChange, Rewrite, Changes } from "./types";

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

  fresh(): LiveEvent[] {
    const out = this.#fresh;
    this.#fresh = [];

    return out;
  }
}

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
        text: r.backMs === null ? `Shard ${r.i} restarted` : `Shard ${r.i} restarted and was back in ${ms(r.backMs)}`,
        shard: r.i,
      });

  return out;
}

// A wasm shard's error is its rewriter's, after which it compacts inline; a container's compaction failed outright.
function rewrites(all: Rewrite[], native: boolean): EventInput[] {
  const out: EventInput[] = [];
  const done = all.filter((r) => !r.error);

  for (const r of all)
    if (r.error)
      out.push({
        level: "warning",
        kind: "rewrite",
        text: native
          ? `Shard ${r.i} couldn't compact its log (${r.error})`
          : `Shard ${r.i} couldn't compact its log in a helper, so it did it itself`,
        shard: r.i,
      });

  if (done.length === 1) {
    const [r] = done;
    out.push({
      level: "success",
      kind: "rewrite",
      text: `Shard ${r.i} compacted its log in ${ms(r.ms)}${r.bytes ? `, to ${bytes(r.bytes)}` : ""}`,
      shard: r.i,
    });
  } else if (done.length)
    out.push({
      level: "success",
      kind: "rewrite",
      text: `${plural(done.length, "shard")} compacted their logs, the slowest in ${ms(Math.max(...done.map((r) => r.ms)))}`,
    });

  return out;
}

const replicaOf = (r: ReplicaChange) => `The replica of shard ${r.i} in ${regionName(r.region)}`;

const ASLEEP = `went to sleep: no traffic for ${plural(REPL_IDLE_MS / 60_000, "minute")}`;

const REPLICA_GROUPS: {
  pick: (r: ReplicaChange) => boolean;
  level: EventLevel;
  many: (n: number) => string;
  one: (r: ReplicaChange) => string;
}[] = [
  {
    pick: (r) => r.to === "asleep",
    level: "info",
    many: (n) => `${plural(n, "replica")} ${ASLEEP}`,
    one: (r) => `${replicaOf(r)} ${ASLEEP}`,
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

// A few events rather than one per shard: a new database's shards all compact at once, say.
export const summarize = (changes: Changes, shardCount: number, native: boolean): EventInput[] => [
  ...restarts(changes.restarts, shardCount),
  ...rewrites(changes.rewrites, native),
  ...replicas(changes.replicas),
];
