import { geoInterpolate } from "d3-geo";
import type { Arc, LonLat } from "./types";

export const has = <T extends { lat: number | null; lon: number | null }>(
  p: T | null | undefined,
): p is T & { lat: number; lon: number } => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon);

export const key = (p: { lat: number; lon: number }) => `${p.lat.toFixed(1)},${p.lon.toFixed(1)}`;

export const arc = (id: string, from: LonLat, to: LonLat, color: string, rate: number, alpha = 0.4): Arc => ({
  id,
  from,
  to,
  color,
  alpha,
  rate,
  at: geoInterpolate(from, to),
});

// Stable per string, so a marker or stream keeps its phase across updates.
export const hash = (s: string) => {
  let h = 2166136261;

  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);

  return (h >>> 0) / 2 ** 32;
};
