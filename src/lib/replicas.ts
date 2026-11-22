// Replica counts and how to talk about them. Asleep is normal (no traffic to that shard for 10 minutes; its
// next read or write wakes them), copying is a few seconds, and only a lost stream is worth a warning.
import { plural } from "./format";
import type { Shard } from "./types";

export interface ReplicaCounts { total: number; ready: number; waking: number; asleep: number; lost: number }

export function replicaCounts(shards: Shard[] | undefined): ReplicaCounts {
  const c = { total: 0, ready: 0, waking: 0, asleep: 0, lost: 0 };
  for (const s of shards ?? []) for (const r of s.replicas ?? []) {
    c.total++;
    if (r.state === "ready") c.ready++;
    else if (r.state === "asleep") c.asleep++;
    else if (r.state === "idle") c.lost++;
    else c.waking++;
  }
  return c;
}

/** One short line ("9 serving, 567 asleep") and a badge variant for it. */
export function replicaLine(c: ReplicaCounts): { text: string; variant: "success" | "warning" | "error" | "neutral" } {
  if (c.ready === c.total) return { text: `${plural(c.total, "replica")} serving`, variant: "success" };
  if (c.asleep === c.total) return { text: `${plural(c.total, "replica")} asleep`, variant: "neutral" };
  const parts = [c.ready && `${c.ready.toLocaleString("en")} serving`, c.waking && `${c.waking.toLocaleString("en")} copying`,
    c.lost && `${c.lost.toLocaleString("en")} reconnecting`, c.asleep && `${c.asleep.toLocaleString("en")} asleep`].filter(Boolean);
  return { text: `Replicas: ${parts.join(", ")}`, variant: c.lost ? "error" : c.waking ? "warning" : "success" };
}

export const SLEEP_NOTE = "A shard's replicas sleep after 10 minutes without traffic to that shard, and its next read or write wakes them in a few seconds.";
