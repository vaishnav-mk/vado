import { plural } from "./format";
import type { Replica, Shard } from "./types";
import { REPL_IDLE_MS } from "@vado/server/replication/config.ts";

export interface ReplicaCounts {
  total: number;
  ready: number;
  waking: number;
  asleep: number;
  lost: number;
}

export function replicaCounts(shards: Shard[] | undefined): ReplicaCounts {
  const c = { total: 0, ready: 0, waking: 0, asleep: 0, lost: 0 };

  for (const s of shards ?? [])
    for (const r of s.replicas ?? []) {
      c.total++;

      if (r.state === "ready") c.ready++;
      else if (r.state === "asleep") c.asleep++;
      else if (r.state === "idle") c.lost++;
      else c.waking++;
    }

  return c;
}

export function replicaLine(c: ReplicaCounts) {
  if (c.ready === c.total) return { text: `${plural(c.total, "replica")} serving`, variant: "success" } as const;

  if (c.asleep === c.total) return { text: `${plural(c.total, "replica")} asleep`, variant: "neutral" } as const;

  const parts = [
    c.ready && `${c.ready.toLocaleString("en")} serving`,
    c.waking && `${c.waking.toLocaleString("en")} copying`,
    c.lost && `${c.lost.toLocaleString("en")} reconnecting`,
    c.asleep && `${c.asleep.toLocaleString("en")} asleep`,
  ].filter(Boolean);

  // Asleep is normal and copying takes seconds, so only a lost stream is worth an error.
  return {
    text: `Replicas: ${parts.join(", ")}`,
    variant: c.lost ? "error" : c.waking ? "warning" : "success",
  } as const;
}

export const replicaReads = (replicas: Replica[]) => replicas.reduce((a, r) => a + (r.reads ?? 0), 0);

export const SLEEP_NOTE = `A shard's replicas sleep after ${plural(REPL_IDLE_MS / 60_000, "minute")} without traffic to that shard, and its next read or write wakes them in a few seconds.`;
