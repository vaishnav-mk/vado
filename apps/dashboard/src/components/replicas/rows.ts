import { isHint, regionName, WORLD } from "@vado/server/catalog/regions.ts";
import { replicaReads } from "../../lib/replicas";
import type { LiveState, Replica } from "../../lib/types";
import type { Row } from "./types";

export function rows(state: LiveState | null): Row[] {
  const shards = state?.shards ?? [];
  const present = new Set(shards.flatMap((s) => (s.replicas ?? []).map((r) => r.region)));

  const order = [
    ...WORLD.filter((r) => present.has(r)),
    ...[...present].filter((r) => !isHint(r) || !WORLD.includes(r)),
  ];

  return order.map((region) => {
    const cells = shards.map((s) => s.replicas?.find((r) => r.region === region));
    const here = cells.filter((r): r is Replica => !!r);
    const ready = here.filter((r) => r.state === "ready");
    const cities = new Map<string, number>();

    for (const r of here) if (r.city) cities.set(r.city, (cities.get(r.city) ?? 0) + 1);
    const city = [...cities].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const note = ready.length
      ? null
      : here.some((r) => r.state === "idle")
        ? "Reconnecting"
        : here.some((r) => r.state === "copying" || r.state === "catching up")
          ? "Copying"
          : "Asleep";

    return {
      region,
      name: here[0]?.regionName || regionName(region),
      city,
      cells,
      lag: ready.length ? Math.max(...ready.map((r) => r.lagMs ?? 0)) : null,
      reads: replicaReads(here),
      note,
    };
  });
}

export function height(r: Replica | undefined, maxLag: number) {
  if (!r) return 0;

  if (r.state === "asleep") return 12;

  if (r.state === "idle") return 100;

  if (r.state !== "ready") return 55;

  return 18 + 82 * Math.min(1, (r.lagMs ?? 0) / maxLag);
}
