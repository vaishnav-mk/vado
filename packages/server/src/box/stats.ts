import type { Flavour } from "../catalog/types";
import { isolate } from "../shard/stats";
import type { ShardStats } from "../shard/types";

interface BoxFacts {
  flavour: Flavour;
  instance: string;
  version: string;
  bornAt: number;
  clients: number;
  stored: number; // bytes of the current base and log
}

// The dashboard's shard shape; the wasm-only fields stay at their empty values.
export const boxStats = (f: BoxFacts): Omit<ShardStats, "files"> => ({
  wasmMemoryBytes: 0,
  sockets: f.clients,
  pooled: 0,
  cronRunning: true,
  vfs: { writes: 0, writeBytes: f.stored, reads: 0, readBytes: 0, rowsWritten: 0 },
  flavour: f.flavour,
  instance: f.instance,
  version: f.version,
  isolate: isolate(),
  colo: null,
  aliveSeconds: (Date.now() - f.bornAt) / 1000,
  restarting: false,
  lastUpgrade: null,
  role: "primary",
  replicas: [],
  lastRewrite: null,
});
