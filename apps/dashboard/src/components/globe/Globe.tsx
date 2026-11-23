// Frames read only refs, so React re-renders just for data (once a second) and the tooltip.
import { useEffect, useMemo, useRef, useState } from "react";
import { geoDistance, geoOrthographic, geoPath } from "d3-geo";
import { LayerCard, Text } from "@cloudflare/kumo";
import { Legend } from "../Legend";
import { HIGHLIGHT, REPLICA, SHARD, traffic } from "../../lib/colors";
import { GLOBE_SPIN } from "../../lib/config";
import { useReducedMotion } from "../../lib/hooks";
import type { LastCommand, LiveState } from "../../lib/types";
import { colorsOf, drawArcs, drawCommand, drawEarth, drawSpots } from "./draw";
import { scene, summary } from "./scene";
import type { Drawn, LonLat, Tip } from "./types";

const TIP_WIDTH = 240;

const clampTilt = (v: number) => Math.max(-90, Math.min(90, v));

const KEY_STEPS = new Map([
  ["ArrowLeft", [-10, 0]],
  ["ArrowRight", [10, 0]],
  ["ArrowUp", [0, -10]],
  ["ArrowDown", [0, 10]],
]);

export function Globe({ state, last, dark }: { state: LiveState | null; last: LastCommand | null; dark: boolean }) {
  const wrap = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null);

  const calm = useReducedMotion();
  const data = useMemo(() => scene(state, last, dark), [state, last, dark]);
  const sceneRef = useRef(data);
  sceneRef.current = data;
  const rot = useRef<[number, number] | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; rot: [number, number] } | null>(null);
  const inside = useRef(false);
  const drawn = useRef<Drawn[]>([]);
  const [tip, setTip] = useState<Tip | null>(null);

  // Face the shards when the first numbers arrive, unless someone already turned the globe.
  const aimed = useRef(false);

  if (!aimed.current && data.center) {
    aimed.current = true;

    if (!drag.current) rot.current = [-data.center[0], -Math.max(-30, Math.min(30, data.center[1])) * 0.6];
  }

  useEffect(() => {
    const c = canvas.current,
      ctx = c?.getContext("2d");

    if (!c || !ctx || !wrap.current) return;
    const colors = colorsOf(wrap.current, dark);
    const projection = geoOrthographic().clipAngle(90);
    const path = geoPath(projection, ctx);
    const phases = new Map<string, number>();

    let raf = 0,
      last = performance.now(),
      visible = true,
      drewAt = 0;

    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
    });

    io.observe(c);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      if (!visible) return;

      if (calm && !drag.current && now - drewAt < 250) return; // still, but keep up with new data
      drewAt = now;

      const dpr = devicePixelRatio || 1,
        size = Math.round(c.clientWidth * dpr);

      if (!size) return;

      if (c.width !== size) {
        c.width = size;
        c.height = size;
      }

      const r = rot.current ?? (rot.current = [-10, -20]);

      if (!calm && !drag.current && !inside.current) r[0] += GLOBE_SPIN * dt;

      projection
        .translate([size / 2, size / 2])
        .scale(size / 2 - 6 * dpr)
        .rotate([r[0], r[1]]);
      const center: LonLat = [-r[0], -r[1]];
      const fade = (p: LonLat) => Math.max(0, Math.min(1, (Math.PI / 2 - geoDistance(p, center)) / 0.12));
      const f = { ctx, path, projection, dpr, size, calm, fade };
      const s = sceneRef.current;

      drawEarth(f, colors);
      drawArcs(f, s.arcs, phases, dt);
      drawCommand(f, s.path);
      drawn.current = drawSpots(f, s.spots, colors.ocean, calm ? 0 : now / 1000);
    };

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [dark, calm]);

  const hit = (x: number, y: number) => {
    let best: Drawn | null = null,
      bd = Infinity;

    for (const d of drawn.current) {
      const dd = Math.hypot(d.x - x, d.y - y);

      if (dd < d.r + 6 && dd < bd) {
        best = d;
        bd = dd;
      }
    }

    return best;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;

    if (d && d.id === e.pointerId) {
      rot.current = [d.rot[0] + (e.clientX - d.x) * 0.3, clampTilt(d.rot[1] - (e.clientY - d.y) * 0.3)];

      return;
    }

    const b = e.currentTarget.getBoundingClientRect(),
      h = hit(e.clientX - b.left, e.clientY - b.top);

    setTip((cur) =>
      h
        ? cur?.title === h.spot.title && cur.lines.join() === h.spot.lines.join()
          ? cur
          : { x: h.x, y: h.y, r: h.r, title: h.spot.title, lines: h.spot.lines }
        : null,
    );
  };

  const caption = summary(state);

  return (
    <LayerCard className="h-full">
      <LayerCard.Secondary>Where traffic comes from and goes</LayerCard.Secondary>
      <LayerCard.Primary className="flex-1 gap-3">
        <div ref={wrap} className="relative mx-auto aspect-square w-full max-w-[460px]">
          <canvas
            ref={canvas}
            tabIndex={0}
            role="img"
            aria-label={`Globe. ${caption} Use the arrow keys to turn it.`}
            className="size-full cursor-grab touch-none rounded-full outline-offset-4 active:cursor-grabbing"
            onPointerEnter={() => {
              inside.current = true;
            }}
            onPointerLeave={() => {
              inside.current = false;

              if (!drag.current) setTip(null);
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              aimed.current = true;
              drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, rot: [...(rot.current ?? [0, 0])] };
              setTip(null);
            }}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => {
              if (drag.current?.id === e.pointerId) drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onKeyDown={(e) => {
              const r = rot.current ?? [0, 0],
                step = KEY_STEPS.get(e.key);

              if (!step) return;
              e.preventDefault();
              aimed.current = true;
              rot.current = [r[0] + step[0], clampTilt(r[1] + step[1])];
            }}
          />
          {tip && <GlobeTip tip={tip} width={wrap.current?.clientWidth ?? 460} />}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          <Legend color={traffic(dark)} label="Traffic entering Cloudflare" />
          <Legend color={SHARD} label="Shards" />
          {state?.shards?.some((s) => s.replicas?.length) && <Legend color={REPLICA.ready} label="Replicas" />}
          {last && <Legend color={HIGHLIGHT} label="Your last command" />}
        </div>
        <Text variant="secondary" size="sm">
          {caption}
        </Text>
      </LayerCard.Primary>
    </LayerCard>
  );
}

function GlobeTip({ tip, width }: { tip: Tip; width: number }) {
  const below = tip.y < 120,
    left = Math.max(4, Math.min(width - TIP_WIDTH - 4, tip.x - TIP_WIDTH / 2));

  return (
    <div
      role="tooltip"
      className={`pointer-events-none absolute z-10 flex flex-col gap-0.5 rounded-lg border border-kumo-line bg-kumo-base px-2.5 py-2 text-xs leading-snug text-kumo-default shadow-lg ${below ? "" : "-translate-y-full"}`}
      style={{ left, width: TIP_WIDTH, top: below ? tip.y + tip.r + 8 : tip.y - tip.r - 8 }}
    >
      <strong>{tip.title}</strong>
      {tip.lines.map((l) => (
        <span key={l} className="text-kumo-subtle">
          {l}
        </span>
      ))}
    </div>
  );
}
