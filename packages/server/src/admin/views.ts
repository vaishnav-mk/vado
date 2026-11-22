// Databases and shards in plain numbers, never a password hash. Browser-safe: the dashboard imports `place`.
import colos from "../replication/colos.json";
import { REGION_NAMES } from "../replication/regions";
import type { DatabaseRecord, DatabaseSummary } from "../catalog/types";
import type { CommandTable } from "../protocol/types";
import type { Database, Place, ReplicaState } from "./live-types";
import type { Calls, ShardLook, ShardReading } from "./types";

// scripts/colos.mjs writes each colo as [city, latitude, longitude].
const COLOS = new Map(
  Object.entries(colos).map(([colo, [city, lat, lon]]) => [
    colo,
    { city: String(city), lat: Number(lat), lon: Number(lon) },
  ]),
);

/** A colo as a place: its code, city and coordinates (null fields if unknown). */
export const place = (colo: string | null): Place => {
  const c = colo === null ? undefined : COLOS.get(colo);

  return c ? { colo, ...c } : { colo, city: null, lat: null, lon: null };
};

export const dbView = (db: DatabaseRecord | DatabaseSummary): Database => ({
  name: db.name,
  created: db.created,
  shards: db.shards,
  regions: db.regions,
  replicas: db.replicas,
  flavour: db.flavour,
  password: "password" in db ? Boolean(db.password) : db.secret !== null,
});

/** INFO commandstats as reads and writes, by each command's flags. Commands that are neither (PING, INFO) don't count. */
export function calls(info: Record<string, string>, table: CommandTable): Calls {
  let reads = 0,
    writes = 0;

  for (const [k, v] of Object.entries(info)) {
    if (!k.startsWith("cmdstat_")) continue;

    const flags = table.get(k.slice(8).split("|")[0])?.flags,
      n = Number(/calls=(\d+)/.exec(v)?.[1] ?? 0);

    if (flags?.has("write")) writes += n;
    else if (flags?.has("readonly")) reads += n;
  }

  return { reads, writes };
}

// "idle" without an error hasn't copied yet (the primary starts on its next tick), so to a person it's copying.
const shown = (state: ReplicaState, error: string | null): ReplicaState =>
  state === "idle" && !error ? "copying" : state;

export function shardView(s: ShardLook, i: number, table: CommandTable): ShardReading | { i: number; down: string } {
  if ("down" in s) return { i, down: s.down };

  const info = s.info,
    n = (k: string) => Number(info[k] ?? 0);

  const copies = new Map(s.replicaSnapshots.flatMap((c) => ("down" in c ? [] : [[c.region, c] as const])));

  return {
    i,
    instance: s.instance,
    version: s.version,
    isolate: s.isolate,
    ...place(s.colo),
    aliveSeconds: s.aliveSeconds,
    keys: Number(/keys=(\d+)/.exec(info.db0 ?? "")?.[1] ?? 0),
    memory: { used: n("used_memory"), max: n("maxmemory"), wasm: s.wasmMemoryBytes },
    calls: calls(info, table),
    clients: n("connected_clients"),
    log: {
      base: n("aof_base_size"),
      size: n("aof_current_size"),
      rewriting: info.aof_rewrite_in_progress === "1",
      lastRewrite: s.lastRewrite,
    },
    replicas: s.replicas.map((r) => {
      const c = copies.get(r.region);

      return {
        region: r.region,
        regionName: REGION_NAMES[r.region] ?? r.region,
        state: shown(r.state, r.error),
        lagMs: r.lagMs,
        behindBytes: r.behindBytes,
        error: r.error,
        ...place(r.colo ?? c?.colo ?? null),
        instance: c?.instance ?? null,
        reads: c ? calls(c.info, table).reads : 0,
      };
    }),
  };
}
