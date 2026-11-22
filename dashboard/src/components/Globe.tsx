// A spinning globe drawn on a canvas with d3-geo, styled like Kumo's GlobeMap (hatched land on the base
// surface). It shows where traffic enters Cloudflare, the shards, their replicas, the streams from each shard
// to its replicas (dots move as fast as the shard's writes), and the last command's path. Everything drawn
// per frame is read from refs; React only re-renders for data (once a second) and for the hover tooltip.
import { useEffect, useMemo, useRef, useState } from "react";
import { geoDistance, geoInterpolate, geoOrthographic, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import land110 from "world-atlas/land-110m.json";
import { ChartPalette, LayerCard, Text } from "@cloudflare/kumo";
import { Legend } from "./Legend";
import { HIGHLIGHT, REPLICA, replicaColor, replicaWords, SHARD, traffic } from "../lib/colors";
import { cities, ms, num, plural } from "../lib/format";
import { useReducedMotion } from "../lib/hooks";
import { place } from "../lib/places";
import type { LastCommand, LiveState, ReplicaState } from "../lib/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LAND = feature(land110 as any, (land110 as any).objects.land) as unknown as GeoJSON.FeatureCollection;
const SPIN = 5; // degrees per second
const PATH_MS = 6_000; // how long the last command's path stays
const TRAVEL_MS = 1_200; // how long its dot takes to cross

type LonLat = [number, number];
interface Layer { kind: "entry" | "shard" | "replica"; color: string; size: number }
/** One place on the globe. What's there is drawn inside out (shards, replicas, traffic), each later layer as a ring
 *  around the earlier ones, so traffic entering in the same city as the shards still shows. */
interface Spot { at: LonLat; title: string; lines: string[]; layers: Layer[]; seed: number }
interface Arc { id: string; from: LonLat; to: LonLat; color: string; alpha: number; rate: number; at: (t: number) => LonLat }
interface Scene { spots: Spot[]; arcs: Arc[]; path: { legs: Arc[]; fan: Arc[]; at: number } | null; center: LonLat | null }

const has = <T extends { lat: number | null; lon: number | null }>(p: T | null | undefined): p is T & { lat: number; lon: number } =>
  !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon);
const key = (p: { lat: number; lon: number }) => `${p.lat.toFixed(1)},${p.lon.toFixed(1)}`;
const arc = (id: string, from: LonLat, to: LonLat, color: string, rate: number, alpha = 0.4): Arc => ({ id, from, to, color, alpha, rate, at: geoInterpolate(from, to) });
/** A stable number in [0, 1) for a string, so a marker or stream keeps its phase across updates. */
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0) / 2 ** 32; };
const shardList = (xs: number[]) => (xs.length > 6 ? `${xs.slice(0, 6).join(", ")} and ${xs.length - 6} more` : xs.join(", "));
const WORST: ReplicaState[] = ["idle", "copying", "catching up", "ready", "asleep"];

/** What the globe shows, from one live picture. Places are grouped, so 64 shards in 9 cities are 9 markers. */
function scene(state: LiveState | null, last: LastCommand | null, dark: boolean): Scene {
  const arcs: Arc[] = [], spots = new Map<string, Spot>();
  const spot = (at: LonLat, title: string, layer: Layer, line: string) => {
    const k = key({ lon: at[0], lat: at[1] }), x = spots.get(k) ?? { at, title, lines: [], layers: [], seed: hash(k) };
    x.layers.push(layer); x.lines.push(line); spots.set(k, x);
  };
  const shards = state?.shards ?? [], entries = (state?.map?.entries ?? []).filter(has);
  const blue = traffic(dark);

  const homes = new Map<string, { at: LonLat; city: string; shards: number[]; writes: number }>();
  for (const s of shards) {
    if (!has(s)) continue;
    const h = homes.get(key(s)) ?? { at: [s.lon, s.lat] as LonLat, city: s.city || "an unknown place", shards: [], writes: 0 };
    h.shards.push(s.i);
    h.writes += s.ok ? s.writes ?? 0 : 0;
    homes.set(key(s), h);
  }
  const copies = new Map<string, { at: LonLat; city: string; region: string; states: ReplicaState[]; reads: number; lag: number }>();
  const streams = new Map<string, { from: LonLat; to: LonLat; rate: number; states: ReplicaState[] }>();
  for (const s of shards) {
    for (const r of s.replicas ?? []) {
      if (!has(r)) continue;
      const c = copies.get(key(r)) ?? { at: [r.lon, r.lat] as LonLat, city: r.city || r.regionName, region: r.regionName || r.region, states: [], reads: 0, lag: 0 };
      c.states.push(r.state);
      c.reads += r.reads ?? 0;
      if (r.state === "ready") c.lag = Math.max(c.lag, r.lagMs ?? 0);
      copies.set(key(r), c);
      if (!has(s) || key(s) === key(r)) continue;
      const k = `${key(s)}>${key(r)}`;
      const st = streams.get(k) ?? { from: [s.lon, s.lat] as LonLat, to: [r.lon, r.lat] as LonLat, rate: 0, states: [] };
      st.rate += s.ok ? s.writes ?? 0 : 0;
      st.states.push(r.state);
      streams.set(k, st);
    }
  }
  const worst = (xs: ReplicaState[]) => WORST.find((w) => xs.includes(w)) ?? "asleep";

  for (const [k, st] of streams) arcs.push(arc(k, st.from, st.to, replicaColor(worst(st.states)), st.rate));
  const top = [...entries].sort((a, b) => b.ops - a.ops).slice(0, 12), targets = [...homes.values()];
  for (const e of top) for (const h of targets) if (key(e) !== key({ lat: h.at[1], lon: h.at[0] })) arcs.push(arc(`${key(e)}>${h.at}`, [e.lon, e.lat], h.at, blue, e.ops / targets.length, 0.18));

  for (const h of homes.values()) {
    spot(h.at, h.city, { kind: "shard", color: SHARD, size: 5 + Math.min(5, Math.sqrt(h.shards.length)) },
      `${h.shards.length === 1 ? "Shard" : "Shards"} ${shardList(h.shards)}${h.writes ? `, taking ${num(h.writes)} writes/s` : ""}`);
  }
  for (const c of copies.values()) {
    const counts = WORST.filter((w) => c.states.includes(w)).map((w) => `${c.states.filter((x) => x === w).length} ${replicaWords(w).toLowerCase()}`);
    spot(c.at, `${c.city}, ${c.region}`, { kind: "replica", color: replicaColor(worst(c.states)), size: 4 },
      `${plural(c.states.length, "read replica")}: ${counts.join(", ")}${c.reads ? `. Serving ${num(c.reads)} reads/s` : ""}${c.lag ? `, up to ${ms(c.lag)} behind` : ""}`);
  }
  for (const e of entries) {
    spot([e.lon, e.lat], e.city || "Traffic", { kind: "entry", color: blue, size: 3 + 2.2 * Math.log10(1 + (e.ops ?? 0)) },
      `${num(e.ops)} commands/s from ${plural(e.conns ?? 0, "open connection")} entering Cloudflare here`);
  }

  let path: Scene["path"] = null;
  const from = last && place(last.colo), shard = last?.shard !== null && last?.shard !== undefined ? shards[last.shard] : undefined;
  if (last && has(from) && has(shard)) {
    const copy = last.replica ? shard.replicas?.find((r) => r.region === last.replica) : undefined;
    const end = has(copy) ? copy : shard;
    path = {
      at: last.at,
      legs: [arc("leg", [from.lon, from.lat], [end.lon, end.lat], HIGHLIGHT, 0)],
      fan: last.write && last.replication ? (shard.replicas ?? []).filter(has).map((r) => arc(r.region, [shard.lon, shard.lat], [r.lon, r.lat], HIGHLIGHT, 0)) : [],
    };
  }
  const centerOf = targets.length ? targets : entries.map((e) => ({ at: [e.lon, e.lat] as LonLat }));
  const center: LonLat | null = centerOf.length ? [centerOf.reduce((a, h) => a + h.at[0], 0) / centerOf.length, centerOf.reduce((a, h) => a + h.at[1], 0) / centerOf.length] : null;
  return { spots: [...spots.values()], arcs, path, center };
}

/** A Kumo color variable as a color the canvas understands (they're light-dark() values). */
function resolve(el: HTMLElement, variable: string, fallback: string) {
  const probe = document.createElement("span");
  probe.style.color = `var(${variable}, ${fallback})`;
  el.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c || fallback;
}

export function Globe({ state, last, dark }: { state: LiveState | null; last: LastCommand | null; dark: boolean }) {
  const wrap = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const calm = useReducedMotion();
  const data = useMemo(() => scene(state, last, dark), [state, last, dark]);
  const sceneRef = useRef(data);
  sceneRef.current = data;
  const rot = useRef<[number, number] | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; rot: [number, number] } | null>(null);
  const inside = useRef(false);
  const drawn = useRef<{ x: number; y: number; r: number; m: Spot }[]>([]);
  const [tip, setTip] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null);

  // Face the shards when the first numbers arrive, unless someone already turned the globe.
  const aimed = useRef(false);
  if (!aimed.current && data.center) { aimed.current = true; if (!drag.current) rot.current = [-data.center[0], -Math.max(-30, Math.min(30, data.center[1])) * 0.6]; }

  useEffect(() => {
    const c = canvas.current, w0 = wrap.current;
    if (!c || !w0) return;
    const ctx = c.getContext("2d")!;
    const colors = {
      ocean: resolve(w0, "--color-kumo-base", dark ? "#171717" : "#ffffff"),
      line: resolve(w0, "--color-kumo-line", dark ? "#3f3f46" : "#e5e7eb"),
      // Kumo's map land color, but stronger: its 1-pixel hatching nearly vanishes on the dark base.
      land: dark ? "#5B5E68" : "#BFC4CC",
      landFill: dark ? "rgba(255,255,255,0.05)" : ChartPalette.mapColors(false).area + "66",
    };
    const projection = geoOrthographic().clipAngle(90);
    const path = geoPath(projection, ctx);
    const phases = new Map<string, number>(); // where each stream's dots are, so a new rate changes speed, not position
    let raf = 0, last = performance.now(), visible = true, drewAt = 0;
    const io = new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; });
    io.observe(c);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!visible) return;
      if (calm && !drag.current && now - drewAt < 250) return; // still, but keep up with new data
      drewAt = now;
      const dpr = devicePixelRatio || 1, size = Math.round(c.clientWidth * dpr);
      if (!size) return;
      if (c.width !== size) { c.width = size; c.height = size; }
      const r = rot.current ?? (rot.current = [-10, -20]);
      if (!calm && !drag.current && !inside.current) r[0] += SPIN * dt;
      const R = size / 2 - 6 * dpr, t = calm ? 0 : now / 1000;
      projection.translate([size / 2, size / 2]).scale(R).rotate([r[0], r[1]]);
      const center: LonLat = [-r[0], -r[1]];
      const fade = (p: LonLat) => Math.max(0, Math.min(1, (Math.PI / 2 - geoDistance(p, center)) / 0.12));
      const s = sceneRef.current;

      ctx.clearRect(0, 0, size, size);
      // Ocean, hatched land, outline: as Kumo's GlobeMap draws them.
      ctx.beginPath(); path({ type: "Sphere" }); ctx.fillStyle = colors.ocean; ctx.fill();
      ctx.save();
      ctx.beginPath(); path(LAND); ctx.fillStyle = colors.landFill; ctx.fill(); ctx.clip();
      ctx.strokeStyle = colors.land; ctx.lineWidth = 1.4 * dpr; ctx.lineCap = "round";
      const gap = Math.max(4 * dpr, size / 90);
      ctx.beginPath();
      for (let o = -size; o < size; o += gap) { ctx.moveTo(o, 0); ctx.lineTo(o + size, size); }
      ctx.stroke();
      ctx.restore();
      ctx.beginPath(); path({ type: "Sphere" }); ctx.strokeStyle = colors.line; ctx.lineWidth = 1.5 * dpr; ctx.stroke();

      // Streams and traffic: faint great circles, with dots that move as fast as their rate.
      for (const a of s.arcs) {
        ctx.globalAlpha = a.alpha;
        ctx.strokeStyle = a.color; ctx.lineWidth = dpr;
        ctx.beginPath(); path({ type: "LineString", coordinates: [a.from, a.to] }); ctx.stroke();
        if (!a.rate) continue;
        const n = Math.max(1, Math.min(5, Math.round(Math.log2(1 + a.rate)))), speed = 0.15 + 0.12 * Math.log10(1 + a.rate);
        const ph = ((phases.get(a.id) ?? hash(a.id)) + (calm ? 0 : speed * dt)) % 1;
        phases.set(a.id, ph);
        ctx.fillStyle = a.color;
        for (let k = 0; k < n; k++) {
          const p = a.at((ph + k / n) % 1), o = fade(p);
          if (!o) continue;
          const [x, y] = projection(p)!;
          ctx.globalAlpha = o;
          ctx.beginPath(); ctx.arc(x, y, 1.8 * dpr, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // The last command: a dot crosses from where it entered to whoever answered, then out to the replicas.
      if (s.path) {
        const age = Date.now() - s.path.at;
        if (age < PATH_MS) {
          const alpha = Math.min(1, (PATH_MS - age) / 1500);
          const leg = (a: Arc, start: number) => {
            const f = calm ? 1 : Math.max(0, Math.min(1, (age - start) / TRAVEL_MS));
            if (!f) return;
            const pts = Array.from({ length: 33 }, (_, k) => a.at((k / 32) * f));
            ctx.globalAlpha = alpha; ctx.strokeStyle = HIGHLIGHT; ctx.lineWidth = 2.5 * dpr;
            ctx.beginPath(); path({ type: "LineString", coordinates: pts }); ctx.stroke();
            const head = pts.at(-1)!, o = fade(head);
            if (f < 1 && o) { const [x, y] = projection(head)!; ctx.globalAlpha = o; ctx.fillStyle = HIGHLIGHT; ctx.beginPath(); ctx.arc(x, y, 4 * dpr, 0, Math.PI * 2); ctx.fill(); }
          };
          for (const a of s.path.legs) leg(a, 0);
          for (const a of s.path.fan) leg(a, TRAVEL_MS);
          ctx.globalAlpha = 1;
        }
      }

      // Places, front side only, fading at the edge: the first layer filled, later ones as rings around it.
      // Traffic pulses softly.
      const seen: typeof drawn.current = [];
      for (const m of s.spots) {
        const o = fade(m.at);
        if (!o) continue;
        const [x, y] = projection(m.at)!;
        let r0 = 0;
        for (const l of m.layers) {
          ctx.globalAlpha = o;
          if (!r0) {
            r0 = l.size * dpr;
            ctx.fillStyle = l.color; ctx.strokeStyle = colors.ocean; ctx.lineWidth = 1.5 * dpr;
            ctx.beginPath(); ctx.arc(x, y, r0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          } else {
            const w = (l.kind === "entry" ? 2.5 : 2) * dpr;
            r0 += 1.5 * dpr + w / 2;
            ctx.strokeStyle = l.color; ctx.lineWidth = w;
            ctx.beginPath(); ctx.arc(x, y, r0, 0, Math.PI * 2); ctx.stroke();
            r0 += w / 2;
          }
          if (l.kind === "entry" && !calm) {
            const ph = (t * 0.6 + m.seed) % 1;
            ctx.globalAlpha = o * 0.5 * (1 - ph); ctx.strokeStyle = l.color; ctx.lineWidth = 1.5 * dpr;
            ctx.beginPath(); ctx.arc(x, y, r0 + ph * 10 * dpr, 0, Math.PI * 2); ctx.stroke();
          }
        }
        seen.push({ x: x / dpr, y: y / dpr, r: r0 / dpr, m });
      }
      ctx.globalAlpha = 1;
      drawn.current = seen;
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); io.disconnect(); };
  }, [dark, calm]);

  const hit = (x: number, y: number) => {
    let best: (typeof drawn.current)[number] | null = null, bd = Infinity;
    for (const d of drawn.current) { const dd = Math.hypot(d.x - x, d.y - y); if (dd < d.r + 6 && dd < bd) { best = d; bd = dd; } }
    return best;
  };
  const local = (e: React.PointerEvent) => { const b = e.currentTarget.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top] as const; };

  const shards = state?.shards ?? [], entries = state?.map?.entries ?? [];
  const homes = [...new Set(shards.map((s) => s.city).filter((c): c is string => !!c))];
  const from = [...entries].sort((a, b) => b.ops - a.ops).map((e) => e.city).filter((c): c is string => !!c);
  const anyReplicas = shards.some((s) => s.replicas?.length);
  const summary = from.length
    ? `Traffic from ${cities(from)}${anyReplicas ? ". Reads go to the nearest replica; writes go to" : " reaches"} shards in ${cities(homes)}.`
    : homes.length ? `Shards in ${cities(homes)}. No traffic right now.` : "Waiting for the first numbers.";

  return (
    <LayerCard className="h-full">
      <LayerCard.Secondary>Where traffic comes from and goes</LayerCard.Secondary>
      <LayerCard.Primary className="flex-1 gap-3">
        <div ref={wrap} className="relative mx-auto aspect-square w-full max-w-[460px]">
          <canvas
            ref={canvas} tabIndex={0} role="img" aria-label={`Globe. ${summary} Use the arrow keys to turn it.`}
            className="size-full cursor-grab touch-none rounded-full outline-offset-4 active:cursor-grabbing"
            onPointerEnter={() => { inside.current = true; }}
            onPointerLeave={() => { inside.current = false; if (!drag.current) setTip(null); }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              aimed.current = true;
              drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, rot: [...(rot.current ?? [0, 0])] as [number, number] };
              setTip(null);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (d && d.id === e.pointerId) {
                rot.current = [d.rot[0] + (e.clientX - d.x) * 0.3, Math.max(-90, Math.min(90, d.rot[1] - (e.clientY - d.y) * 0.3))];
                return;
              }
              const [x, y] = local(e), h = hit(x, y);
              setTip((cur) => (h ? (cur?.title === h.m.title && cur.lines.join() === h.m.lines.join() ? cur : { x: h.x, y: h.y - h.r, title: h.m.title, lines: h.m.lines }) : null));
            }}
            onPointerUp={(e) => { if (drag.current?.id === e.pointerId) drag.current = null; }}
            onPointerCancel={() => { drag.current = null; }}
            onKeyDown={(e) => {
              const r = rot.current ?? [0, 0], step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[e.key];
              if (!step) return;
              e.preventDefault();
              aimed.current = true;
              rot.current = [r[0] + step[0], Math.max(-90, Math.min(90, r[1] + step[1]))];
            }}
          />
          {tip && (
            <div role="tooltip" className="pointer-events-none absolute z-10 flex max-w-64 -translate-x-1/2 -translate-y-full flex-col gap-0.5 rounded-lg border border-kumo-line bg-kumo-base px-2 py-1.5 text-xs text-kumo-default shadow-lg"
              style={{ left: tip.x, top: tip.y - 6 }}>
              <strong>{tip.title}</strong>
              {tip.lines.map((l) => <span key={l} className="text-kumo-subtle">{l}</span>)}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          <Legend color={traffic(dark)} label="Traffic entering Cloudflare" />
          <Legend color={SHARD} label="Shards" />
          {anyReplicas && <Legend color={REPLICA.ready} label="Replicas" />}
          {last && <Legend color={HIGHLIGHT} label="Your last command" />}
        </div>
        <Text variant="secondary" size="sm">{summary}</Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}
