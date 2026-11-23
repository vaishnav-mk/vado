// Places are grouped, so 64 shards in 9 cities are 9 markers.
import { place } from "@vado/server/admin/views.ts";
import { HIGHLIGHT, replicaColor, replicaWords, SHARD, traffic } from "../../lib/colors";
import { MAX_ENTRY_ARCS, MAX_STREAMS } from "../../lib/config";
import { cities, ms, num, plural } from "../../lib/format";
import type { LastCommand, LiveState, ReplicaState } from "../../lib/types";
import { arc, has, hash, key } from "./geo";
import type { Arc, Layer, LonLat, Scene, Spot } from "./types";

const shardList = (xs: number[]) =>
  xs.length > 6 ? `${xs.slice(0, 6).join(", ")} and ${xs.length - 6} more` : xs.join(", ");

const WORST: ReplicaState[] = ["idle", "copying", "catching up", "ready", "asleep"];

const worst = (xs: ReplicaState[]) => WORST.find((w) => xs.includes(w)) ?? "asleep";

export function scene(state: LiveState | null, last: LastCommand | null, dark: boolean): Scene {
  const arcs: Arc[] = [],
    spots = new Map<string, Spot>();

  const spot = (at: LonLat, title: string, layer: Layer, line: string) => {
    const k = key({ lon: at[0], lat: at[1] }),
      x = spots.get(k) ?? { at, title, lines: [], layers: [], seed: hash(k) };

    x.layers.push(layer);
    x.lines.push(line);
    spots.set(k, x);
  };

  const shards = state?.shards ?? [],
    entries = (state?.map?.entries ?? []).filter(has);

  const blue = traffic(dark);

  const homes = new Map<string, { at: LonLat; city: string; shards: number[]; writes: number }>();

  for (const s of shards) {
    if (!has(s)) continue;
    const h = homes.get(key(s)) ?? { at: [s.lon, s.lat], city: s.city || "an unknown place", shards: [], writes: 0 };
    h.shards.push(s.i);
    h.writes += s.ok ? (s.writes ?? 0) : 0;
    homes.set(key(s), h);
  }

  const copies = new Map<
    string,
    { at: LonLat; city: string; region: string; states: ReplicaState[]; reads: number; lag: number }
  >();

  const streams = new Map<string, { from: LonLat; to: LonLat; rate: number; states: ReplicaState[] }>();

  for (const s of shards) {
    for (const r of s.replicas ?? []) {
      if (!has(r)) continue;

      const c = copies.get(key(r)) ?? {
        at: [r.lon, r.lat],
        city: r.city || r.regionName,
        region: r.regionName || r.region,
        states: [],
        reads: 0,
        lag: 0,
      };

      c.states.push(r.state);
      c.reads += r.reads ?? 0;

      if (r.state === "ready") c.lag = Math.max(c.lag, r.lagMs ?? 0);
      copies.set(key(r), c);

      if (!has(s) || key(s) === key(r)) continue;
      const k = `${key(s)}>${key(r)}`;
      const st = streams.get(k) ?? { from: [s.lon, s.lat], to: [r.lon, r.lat], rate: 0, states: [] };

      if (r.state === "asleep" || r.state === "idle" || !s.ok || !s.writes) continue; // nothing is moving
      st.rate += s.writes;
      st.states.push(r.state);
      streams.set(k, st);
    }
  }

  const busiest = [...streams].sort((a, b) => b[1].rate - a[1].rate).slice(0, MAX_STREAMS);

  for (const [k, st] of busiest)
    arcs.push(
      arc(
        k,
        st.from,
        st.to,
        replicaColor(worst(st.states)),
        st.rate,
        0.3 + 0.3 * Math.min(1, Math.log10(1 + st.rate) / 3),
      ),
    );
  // Every client talks to every shard, so for widely spread shards these arcs would join everything to everything.
  const targets = [...homes.values()];

  if (targets.length <= MAX_ENTRY_ARCS) {
    for (const e of [...entries].sort((a, b) => b.ops - a.ops).slice(0, 8))
      for (const h of targets)
        if (key(e) !== key({ lat: h.at[1], lon: h.at[0] }))
          arcs.push(arc(`${key(e)}>${h.at.join()}`, [e.lon, e.lat], h.at, blue, e.ops / targets.length, 0.25));
  }

  for (const h of homes.values()) {
    spot(
      h.at,
      h.city,
      { kind: "shard", color: SHARD, size: 5 + Math.min(5, Math.sqrt(h.shards.length)) },
      `${h.shards.length === 1 ? "Shard" : "Shards"} ${shardList(h.shards)}${h.writes ? `, taking ${num(h.writes)} writes/s` : ""}`,
    );
  }

  for (const c of copies.values()) {
    const counts = WORST.flatMap((w) =>
      c.states.includes(w) ? [`${c.states.filter((x) => x === w).length} ${replicaWords(w).toLowerCase()}`] : [],
    );

    const asleep = c.states.every((x) => x === "asleep");
    spot(
      c.at,
      `${c.city}, ${c.region}`,
      { kind: "replica", color: replicaColor(worst(c.states)), size: asleep ? 2.5 : 4, alpha: asleep ? 0.55 : 1 },
      `${plural(c.states.length, "read replica")}: ${counts.join(", ")}${c.reads ? `. Serving ${num(c.reads)} reads/s` : ""}${c.lag ? `, up to ${ms(c.lag)} behind` : ""}`,
    );
  }

  for (const e of entries) {
    spot(
      [e.lon, e.lat],
      e.city || "Traffic",
      { kind: "entry", color: blue, size: 3 + 2.2 * Math.log10(1 + (e.ops ?? 0)) },
      `${num(e.ops)} commands/s from ${plural(e.conns ?? 0, "open connection")} entering Cloudflare here`,
    );
  }

  let path: Scene["path"] = null;

  const from = last && place(last.colo),
    shard = last?.shard !== null && last?.shard !== undefined ? shards[last.shard] : undefined;

  if (last && has(from) && has(shard)) {
    const copy = last.replica ? shard.replicas?.find((r) => r.region === last.replica) : undefined;
    const end = has(copy) ? copy : shard;
    path = {
      at: last.at,
      legs: [arc("leg", [from.lon, from.lat], [end.lon, end.lat], HIGHLIGHT, 0)],
      fan:
        last.write && last.replication
          ? (shard.replicas ?? [])
              .filter(has)
              .map((r) => arc(r.region, [shard.lon, shard.lat], [r.lon, r.lat], HIGHLIGHT, 0))
          : [],
    };
  }

  const centerOf = targets.length ? targets : entries.map((e) => ({ at: [e.lon, e.lat] satisfies LonLat }));

  const center: LonLat | null = centerOf.length
    ? [
        centerOf.reduce((a, h) => a + h.at[0], 0) / centerOf.length,
        centerOf.reduce((a, h) => a + h.at[1], 0) / centerOf.length,
      ]
    : null;

  return { spots: [...spots.values()], arcs, path, center };
}

export function summary(state: LiveState | null): string {
  const shards = state?.shards ?? [],
    entries = state?.map?.entries ?? [];

  const homes = [...new Set(shards.map((s) => s.city).filter((c): c is string => !!c))];

  const from = [...entries]
    .sort((a, b) => b.ops - a.ops)
    .map((e) => e.city)
    .filter((c): c is string => !!c);

  const anyReplicas = shards.some((s) => s.replicas?.length);

  return from.length
    ? `Traffic from ${cities(from)}${anyReplicas ? ". Reads go to the nearest replica; writes go to" : " reaches"} shards in ${cities(homes)}.`
    : homes.length
      ? `Shards in ${cities(homes)}. No traffic right now.`
      : "Waiting for the first numbers.";
}
