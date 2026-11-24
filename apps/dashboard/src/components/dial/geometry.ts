import { SLOTS } from "@vado/server/protocol/slots.ts";
import { replicaReads } from "../../lib/replicas";
import type { Shard } from "../../lib/types";

export const R_IN = 120,
  R_OUT = 178,
  R_HUB = 112;

const first = (i: number, n: number) => Math.ceil((i * SLOTS) / n);
const ang = (slot: number) => (slot / SLOTS) * Math.PI * 2 - Math.PI / 2;
export const pt = (r: number, a: number): [number, number] => [200 + r * Math.cos(a), 200 + r * Math.sin(a)];

export function arcSpan(i: number, n: number): [number, number] {
  const gap = n > 1 ? Math.min(0.012, (Math.PI / n) * 0.1) : 0;
  const a0 = ang(first(i, n)) + gap;
  let a1 = ang(first(i + 1, n)) - gap;

  if (a1 - a0 > Math.PI * 2 - 1e-3) a1 = a0 + Math.PI * 2 - 1e-3;

  return [a0, a1];
}

export function annulus(r0: number, r1: number, a0: number, a1: number) {
  const large = a1 - a0 > Math.PI ? 1 : 0,
    [x0, y0] = pt(r1, a0),
    [x1, y1] = pt(r1, a1),
    [x2, y2] = pt(r0, a1),
    [x3, y3] = pt(r0, a0);

  return `M${x0} ${y0}A${r1} ${r1} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${large} 0 ${x3} ${y3}Z`;
}

export const ops = (s: Shard | undefined) => (s?.ok ? s.reads + s.writes + replicaReads(s.replicas) : 0);
