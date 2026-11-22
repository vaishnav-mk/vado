// What the dashboard is told about a database and its shards: plain numbers, no password hashes.
import { COLOS } from "../replication/colos.js";
import { REGION_NAMES } from "../replication/regions.js";

/** A colo as a place: its code, city and coordinates (null fields if unknown). */
export const place = (colo) => {
  const c = colo && COLOS[colo];
  return { colo: colo ?? null, city: c?.[0] ?? null, lat: c?.[1] ?? null, lon: c?.[2] ?? null };
};

/** A catalog record without its password hash. */
export const dbView = (db) => ({
  name: db.name, created: db.created, shards: db.shards, regions: db.regions ?? null, replicas: db.replicas ?? null, flavour: db.flavour ?? "valkey",
  password: !!(db.secret ?? db.password),
});

/** Valkey's per-command call counts (INFO commandstats) as reads and writes, by each command's own flags.
 *  Commands that are neither (PING, INFO, AUTH, ...) aren't counted. */
export function calls(info, table) {
  let reads = 0, writes = 0;
  for (const [k, v] of Object.entries(info ?? {})) {
    if (!k.startsWith("cmdstat_")) continue;
    const e = table.get(k.slice(8).split("|")[0]), n = Number(/calls=(\d+)/.exec(v)?.[1] ?? 0);
    if (e?.flags.has("write")) writes += n;
    else if (e?.flags.has("readonly")) reads += n;
  }
  return { reads, writes };
}

/** One shard's snapshot (src/admin/snapshot.js) in plain numbers. Call counts are running totals. */
export function shardView(s, i, table) {
  if (s.down) return { i, down: s.down };
  const info = s.info, n = (k) => Number(info[k] ?? 0);
  const copies = new Map((s.replicaSnapshots ?? []).filter((c) => !c.down).map((c) => [c.region, c]));
  return {
    i, instance: s.instance, version: s.version ?? null, isolate: s.isolate, ...place(s.colo), aliveSeconds: s.aliveSeconds,
    keys: Number(/keys=(\d+)/.exec(info.db0 ?? "")?.[1] ?? 0),
    memory: { used: n("used_memory"), max: n("maxmemory"), wasm: s.wasmMemoryBytes ?? 0 },
    calls: calls(info, table),
    clients: n("connected_clients"),
    log: { base: n("aof_base_size"), size: n("aof_current_size"), rewriting: info.aof_rewrite_in_progress === "1", lastRewrite: s.lastRewrite ?? null },
    replicas: (s.replicas ?? []).map((r) => {
      const c = copies.get(r.region);
      return {
        // "idle" without an error hasn't copied yet (the primary starts it on its next tick), so it's copying
        // as far as a person is concerned; with one, it lost its stream and copies again soon.
        region: r.region, regionName: REGION_NAMES[r.region] ?? r.region, state: r.state === "idle" && !r.error ? "copying" : r.state, lagMs: r.lagMs ?? null,
        behindBytes: r.behindBytes ?? 0, error: r.error ?? null, ...place(r.colo ?? c?.colo), instance: c?.instance ?? null,
        reads: c ? calls(c.info, table).reads : 0,
      };
    }),
  };
}
