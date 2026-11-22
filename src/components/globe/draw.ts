import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import land110 from "world-atlas/land-110m.json";
import { ChartPalette } from "@cloudflare/kumo";
import { HIGHLIGHT } from "../../lib/colors";
import { COMMAND_PATH_MS, COMMAND_TRAVEL_MS } from "../../lib/config";
import { hash } from "./geo";
import type { Arc, Colors, CommandPath, Drawn, Frame, LonLat, Spot } from "./types";

// SAFETY: world-atlas's land-110m.json is a TopoJSON topology whose `land` object is a GeometryCollection; TypeScript
// infers its JSON with `type: string`, not those literal types.
const TOPOLOGY = land110 as Topology<{ land: GeometryCollection }>;
const LAND = feature(TOPOLOGY, TOPOLOGY.objects.land);

/** A Kumo color variable as a color the canvas understands (they're light-dark() values). */
function resolve(el: HTMLElement, variable: string, fallback: string) {
  const probe = document.createElement("span");
  probe.style.color = `var(${variable}, ${fallback})`;
  el.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();

  return c || fallback;
}

export const colorsOf = (el: HTMLElement, dark: boolean): Colors => ({
  ocean: resolve(el, "--color-kumo-base", dark ? "#171717" : "#ffffff"),
  line: resolve(el, "--color-kumo-line", dark ? "#3f3f46" : "#e5e7eb"),
  // Kumo's map land color, but stronger: its 1-pixel hatching nearly vanishes on the dark base.
  land: dark ? "#5B5E68" : "#BFC4CC",
  landFill: dark ? "rgba(255,255,255,0.05)" : ChartPalette.mapColors(false).area + "66",
});

const dot = (f: Frame, p: LonLat, radius: number) => {
  const xy = f.projection(p);

  if (!xy) return;
  f.ctx.beginPath();
  f.ctx.arc(xy[0], xy[1], radius * f.dpr, 0, Math.PI * 2);
  f.ctx.fill();
};

/** Ocean, hatched land, outline: as Kumo's GlobeMap draws them. */
export function drawEarth(f: Frame, colors: Colors) {
  const { ctx, path, dpr, size } = f;

  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  path({ type: "Sphere" });
  ctx.fillStyle = colors.ocean;
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  path(LAND);
  ctx.fillStyle = colors.landFill;
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = colors.land;
  ctx.lineWidth = 1.4 * dpr;
  ctx.lineCap = "round";
  const gap = Math.max(4 * dpr, size / 90);
  ctx.beginPath();

  for (let o = -size; o < size; o += gap) {
    ctx.moveTo(o, 0);
    ctx.lineTo(o + size, size);
  }

  ctx.stroke();
  ctx.restore();
  ctx.beginPath();
  path({ type: "Sphere" });
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();
}

/** Streams and traffic: faint great circles, with dots that move as fast as their rate. `phases` keeps where each
 *  stream's dots are, so a new rate changes their speed, not their position. */
export function drawArcs(f: Frame, arcs: Arc[], phases: Map<string, number>, dt: number) {
  const { ctx, path, dpr, calm } = f;

  for (const a of arcs) {
    ctx.globalAlpha = a.alpha;
    ctx.strokeStyle = a.color;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    path({ type: "LineString", coordinates: [a.from, a.to] });
    ctx.stroke();

    if (!a.rate) continue;

    const n = Math.max(1, Math.min(5, Math.round(Math.log2(1 + a.rate)))),
      speed = 0.15 + 0.12 * Math.log10(1 + a.rate);

    const ph = ((phases.get(a.id) ?? hash(a.id)) + (calm ? 0 : speed * dt)) % 1;
    phases.set(a.id, ph);
    ctx.fillStyle = a.color;

    for (let k = 0; k < n; k++) {
      const p = a.at((ph + k / n) % 1),
        o = f.fade(p);

      if (!o) continue;
      ctx.globalAlpha = o;
      dot(f, p, 1.8);
    }
  }

  ctx.globalAlpha = 1;
}

/** The last command: a dot crosses from where it entered to whoever answered, then out to the replicas. */
export function drawCommand(f: Frame, command: CommandPath | null) {
  if (!command) return;
  const age = Date.now() - command.at;

  if (age >= COMMAND_PATH_MS) return;

  const { ctx, path, dpr, calm } = f,
    alpha = Math.min(1, (COMMAND_PATH_MS - age) / 1500);

  const leg = (a: Arc, start: number) => {
    const done = calm ? 1 : Math.max(0, Math.min(1, (age - start) / COMMAND_TRAVEL_MS));

    if (!done) return;
    const pts = Array.from({ length: 33 }, (_, k) => a.at((k / 32) * done));
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = HIGHLIGHT;
    ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath();
    path({ type: "LineString", coordinates: pts });
    ctx.stroke();

    const head = a.at(done),
      o = f.fade(head);

    if (done < 1 && o) {
      ctx.globalAlpha = o;
      ctx.fillStyle = HIGHLIGHT;
      dot(f, head, 4);
    }
  };

  for (const a of command.legs) leg(a, 0);

  for (const a of command.fan) leg(a, COMMAND_TRAVEL_MS);
  ctx.globalAlpha = 1;
}

/** Places, front side only, fading at the edge: the first layer filled, later ones as rings around it. Traffic
 *  pulses softly. Returns where each was drawn. */
export function drawSpots(f: Frame, spots: Spot[], ocean: string, t: number): Drawn[] {
  const { ctx, dpr, calm } = f,
    drawn: Drawn[] = [];

  const ring = (x: number, y: number, r: number) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  };

  for (const spot of spots) {
    const o = f.fade(spot.at),
      xy = o ? f.projection(spot.at) : null;

    if (!xy) continue;
    const [x, y] = xy;
    let r0 = 0;

    for (const l of spot.layers) {
      ctx.globalAlpha = o * (l.alpha ?? 1);

      if (!r0) {
        r0 = l.size * dpr;
        ctx.fillStyle = l.color;
        ctx.strokeStyle = ocean;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.arc(x, y, r0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        const w = (l.kind === "entry" ? 2.5 : 2) * dpr;
        r0 += 1.5 * dpr + w / 2;
        ctx.strokeStyle = l.color;
        ctx.lineWidth = w;
        ring(x, y, r0);
        r0 += w / 2;
      }

      if (l.kind === "entry" && !calm) {
        const ph = (t * 0.6 + spot.seed) % 1;
        ctx.globalAlpha = o * 0.5 * (1 - ph);
        ctx.strokeStyle = l.color;
        ctx.lineWidth = 1.5 * dpr;
        ring(x, y, r0 + ph * 10 * dpr);
      }
    }

    drawn.push({ x: x / dpr, y: y / dpr, r: r0 / dpr, spot });
  }

  ctx.globalAlpha = 1;

  return drawn;
}
