// Browser-safe: the dashboard imports `place`.
import colos from "../replication/colos.json";
import { regionName } from "../replication/regions";
import type { DatabaseRecord, DatabaseSummary } from "../catalog/types";
import type { CommandTable } from "../protocol/types";
import type { Database, Place, ReplicaState } from "./live-types";
import type { Calls, ShardLook, ShardSeen } from "./types";
import { subField } from "../shard/info";

const COLOS = new Map(
  Object.entries(colos).map(([colo, [city, lat, lon]]) => [
    colo,
    { city: String(city), lat: Number(lat), lon: Number(lon) },
  ]),
);

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

export function calls(info: Record<string, string>, table: CommandTable): Calls {
  let reads = 0,
    writes = 0;

  for (const [k, v] of Object.entries(info)) {
    if (!k.startsWith("cmdstat_")) continue;

    const flags = table.get(k.slice(8).split("|")[0])?.flags,
      n = subField(v, "calls");

    if (flags?.has("write")) writes += n;
    else if (flags?.has("readonly")) reads += n;
  }

  return { reads, writes };
}

// "idle" without an error hasn't started copying yet (the primary starts on its next tick).
const shown = (state: ReplicaState, error: string | null): ReplicaState =>
  state === "idle" && !error ? "copying" : state;

export function shardView(s: ShardLook, i: number, table: CommandTable): ShardSeen {
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
    keys: subField(info.db0, "keys"),
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
        regionName: regionName(r.region),
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
