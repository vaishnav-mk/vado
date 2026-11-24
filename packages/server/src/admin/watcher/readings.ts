import { regionName } from "../../catalog/regions";
import { subField } from "../../protocol/info";
import type { CommandTable } from "../../protocol/types";
import type { ShardLook } from "../types";
import { place } from "../views";
import type { Calls, ShardSeen } from "./types";

function calls(info: Record<string, string>, table: CommandTable): Calls {
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
        // "idle" without an error hasn't started copying yet (the primary starts on its next tick).
        state: r.state === "idle" && !r.error ? "copying" : r.state,
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
