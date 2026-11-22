// The shard dial: every key hashes to one of 16,384 slots, and each shard owns one arc of them. Brighter
// arcs are busier; dots fly from the middle into each shard as fast as its traffic; dots outside are its
// replicas. The last command's shard is ringed.
import { useEffect, useRef, useState } from "react";
import { LayerCard, Text } from "@cloudflare/kumo";
import { HIGHLIGHT, REPLICA, replicaColor, SHARD, traffic } from "../lib/colors";
import { Legend } from "./Legend";
import { bytes, num, plural } from "../lib/format";
import { useReducedMotion } from "../lib/hooks";
import { SLOTS } from "../lib/places";
import type { Shard } from "../lib/types";

const R_IN = 120, R_OUT = 178, R_HUB = 112;
const first = (i: number, n: number) => Math.ceil((i * SLOTS) / n);
const ang = (slot: number) => (slot / SLOTS) * Math.PI * 2 - Math.PI / 2;
const pt = (r: number, a: number): [number, number] => [200 + r * Math.cos(a), 200 + r * Math.sin(a)];

function arcSpan(i: number, n: number): [number, number] {
  const gap = n > 1 ? Math.min(0.012, (Math.PI / n) * 0.1) : 0;
  const a0 = ang(first(i, n)) + gap;
  let a1 = ang(first(i + 1, n)) - gap;
  if (a1 - a0 > Math.PI * 2 - 1e-3) a1 = a0 + Math.PI * 2 - 1e-3;
  return [a0, a1];
}

function annulus(r0: number, r1: number, a0: number, a1: number) {
  const large = a1 - a0 > Math.PI ? 1 : 0, [x0, y0] = pt(r1, a0), [x1, y1] = pt(r1, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
  return `M${x0} ${y0}A${r1} ${r1} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${large} 0 ${x3} ${y3}Z`;
}

/** All of a shard's replicas as one state: serving if any serves, else copying, reconnecting, or asleep. */
const summaryState = (reps: { state: string }[]) =>
  reps.some((r) => r.state === "ready") ? "ready" : reps.some((r) => r.state === "copying" || r.state === "catching up") ? "copying" : reps.some((r) => r.state === "idle") ? "idle" : "asleep";
const ops = (s: Shard | undefined) => (s?.ok ? (s.reads ?? 0) + (s.writes ?? 0) + s.replicas.reduce((a, r) => a + (r.reads ?? 0), 0) : 0);

export function ShardDial({ shards, count, total, dark, selected, onSelect, highlight }: {
  shards: Shard[];
  count: number;
  total: number;
  dark: boolean;
  selected: number | null;
  onSelect: (i: number | null) => void;
  highlight: number | null;
}) {
  const n = Math.max(1, count || shards.length), max = Math.max(1, ...shards.map(ops));
  const read = traffic(dark), calm = useReducedMotion();
  const level = (s: Shard | undefined) => (s?.ok && ops(s) ? Math.log1p(ops(s)) / Math.log1p(Math.max(max, 500)) : 0);
  const [hover, setHover] = useState<number | null>(null);
  const focus = hover ?? selected, f = focus !== null ? shards[focus] : undefined;
  const canvas = useRef<HTMLCanvasElement>(null), live = useRef({ shards, n });
  live.current = { shards, n };

  // Traffic: dots flying from the middle into each shard, reads in blue, writes in orange.
  useEffect(() => {
    if (calm) return;
    type Dot = { a: number; r: number; v: number; write: boolean };
    let dots: Dot[] = [], last = performance.now(), raf = 0;
    const acc = new Map<number, number>();
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current, cur = live.current;
      if (!c) return;
      const dt = Math.min(0.05, (t - last) / 1000), w = Math.round(c.clientWidth * devicePixelRatio);
      last = t;
      if (!w) return;
      if (c.width !== w) { c.width = w; c.height = w; }
      const ctx = c.getContext("2d")!, k = w / 400;
      ctx.clearRect(0, 0, w, w);
      for (const s of cur.shards) {
        const o = ops(s);
        if (!s.ok || !o) continue;
        let a = (acc.get(s.i) ?? 0) + Math.min(50, 1.8 * Math.sqrt(o)) * dt;
        const [a0, a1] = arcSpan(s.i, cur.n), share = (s.writes ?? 0) / o;
        for (; a >= 1; a--) dots.push({ a: a0 + Math.random() * (a1 - a0), r: R_HUB, v: 120 + Math.random() * 60, write: Math.random() < share });
        acc.set(s.i, a);
      }
      dots = dots.filter((p) => p.r < R_IN - 2);
      for (const p of dots) {
        p.r += p.v * dt;
        const [x, y] = pt(p.r, p.a);
        ctx.fillStyle = p.write ? SHARD : read;
        ctx.globalAlpha = Math.max(0, Math.min(1, (p.r - R_HUB) / 10, (R_IN - p.r) / 8));
        ctx.beginPath(); ctx.arc(x * k, y * k, 1.6 * k, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [read, calm]);

  const toggle = (i: number) => onSelect(selected === i ? null : i);
  const busiest = shards.reduce<Shard | undefined>((b, s) => (ops(s) > ops(b) ? s : b), undefined);
  const hasReplicas = shards.some((s) => s.replicas?.length);
  return (
    <LayerCard className="h-full">
      <LayerCard.Secondary>Shards</LayerCard.Secondary>
      <LayerCard.Primary className="flex-1 items-center gap-3">
        <div className="relative aspect-square w-full max-w-[360px]">
          <svg viewBox="0 0 400 400" className="absolute inset-0 size-full" role="group" aria-label={`${plural(n, "shard")}, brighter with more traffic`}>
            <circle cx="200" cy="200" r={R_HUB} className="fill-none stroke-kumo-hairline" />
            {Array.from({ length: n }, (_, i) => {
              const s = shards[i], [a0, a1] = arcSpan(i, n), l = level(s), [lx, ly] = pt((R_IN + R_OUT) / 2, (a0 + a1) / 2);
              const reps = s?.replicas ?? [];
              return (
                <g key={i} role="button" tabIndex={0} aria-label={`Shard ${i}`} aria-pressed={selected === i}
                  onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                  onClick={() => toggle(i)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(i); } }}
                  className="cursor-pointer outline-none">
                  <path d={annulus(R_IN, R_OUT, a0, a1)} className={`${s && !s.ok ? "fill-kumo-danger/30" : "fill-kumo-recessed"} stroke-kumo-base`} strokeWidth={2} />
                  {l > 0 && <path d={annulus(R_IN, R_OUT, a0, a1)} style={{ fill: read, fillOpacity: 0.15 + 0.85 * l }} className="transition-[fill-opacity] duration-700" />}
                  {(selected === i || hover === i) && <path d={annulus(R_IN, R_OUT, a0, a1)} className="fill-none stroke-kumo-brand" strokeWidth={3} />}
                  {highlight === i && <path d={annulus(R_IN - 6, R_OUT + 4, a0, a1)} fill="none" stroke={HIGHLIGHT} strokeWidth={3} className="motion-safe:animate-pulse" />}
                  {n <= 32 && <text x={lx} y={ly} textAnchor="middle" dominantBaseline="central" className={`pointer-events-none text-[15px] font-semibold ${l > 0.55 ? "fill-white" : "fill-current text-kumo-default"}`}>{i}</text>}
                  {/* A dot per replica, or past 16 shards one per shard for all of its replicas (else 576 dots make a solid ring). */}
                  {(n > 16 && reps.length ? [{ region: "all", state: summaryState(reps) }] : reps).map((r, k, all) => {
                    const [dx, dy] = pt(R_OUT + 10, a0 + ((k + 0.5) / all.length) * (a1 - a0));
                    return <circle key={r.region} cx={dx} cy={dy} r={n > 16 ? 2.4 : 3.2} style={{ fill: replicaColor(r.state), opacity: r.state === "asleep" ? 0.5 : 1 }} />;
                  })}
                </g>
              );
            })}
          </svg>
          <canvas ref={canvas} className="pointer-events-none absolute inset-0 size-full" aria-hidden />
          <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
            <span className="text-3xl font-semibold tabular-nums">{num(total)}</span>
            <Text variant="secondary" size="sm">commands/s</Text>
          </div>
        </div>
        <Text variant="secondary" size="sm">
          {f
            ? f.ok
              ? `Shard ${f.i}${f.city ? ` in ${f.city}` : ""}: ${num(ops(f))} commands/s, ${(f.keys ?? 0).toLocaleString("en")} keys, ${bytes(f.memory?.used)}`
              : `Shard ${f.i} isn't responding`
            : focus !== null
              ? `Shard ${focus}: waiting for its numbers`
              : "Each key belongs to one shard. Brighter shards are busier. Select one to find it in the table."}
        </Text>
        <div className="mt-auto flex w-full flex-col gap-3 border-t border-kumo-hairline pt-3">
          {busiest && (
            <div className="flex items-baseline justify-between gap-3">
              <Text variant="secondary" size="sm">Busiest right now</Text>
              <button type="button" className="text-right text-sm font-medium tabular-nums hover:underline" onClick={() => onSelect(busiest.i)}>
                Shard {busiest.i}{busiest.city ? ` in ${busiest.city}` : ""}, {num(ops(busiest))}/s
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Legend color={read} label="Reads" />
            <Legend color={SHARD} label="Writes" />
            {hasReplicas && (
              <>
                <Legend color={REPLICA.ready} label="Replica ready" />
                <Legend color={REPLICA.copying} label="Copying" />
                <Legend color={REPLICA.asleep} label="Asleep" />
                <Legend color={REPLICA.idle} label="Lost its stream" />
              </>
            )}
          </div>
        </div>
      </LayerCard.Primary>
    </LayerCard>
  );
}
