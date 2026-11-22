import { infoFields } from "./info";
import type { DroppedStats, ShardSnapshot, ShardStats } from "./types";

// Objects of one class share isolates (and an isolate's memory limit), so stats() says which one this is.
let isolateId: string | null = null;

export const isolate = (): string => (isolateId ??= crypto.randomUUID());

export const droppedStats = (instance: string): DroppedStats => ({
  dropped: true,
  instance,
  isolate: isolate(),
  files: [],
  replicas: [],
});

/** The INFO sections snapshot() reads. */
export const SNAPSHOT_INFO = [
  "INFO",
  "server",
  "clients",
  "memory",
  "persistence",
  "stats",
  "keyspace",
  "commandstats",
];

/** stats() without its file listing, plus Valkey's INFO fields. */
export function snapshotOf({ files: _files, ...stats }: ShardStats, info: string): ShardSnapshot {
  return { ...stats, info: infoFields(info) };
}
