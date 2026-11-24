import { compact } from "@vado/server/format.ts";

export { ago, bytes, bytesOf, clock, dateTime, duration, list, ms, num, plural, share } from "@vado/server/format.ts";

// Steps of 1, 2 or 5 times a power of ten, so no two axis labels repeat.
export function niceAxis(max: number, minStep = 1, steps = 4) {
  const raw = (max > 0 ? max : 1) / steps;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(minStep, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);

  return { max: Math.max(step, Math.ceil(max / step - 1e-9) * step), step };
}

export function axisLabel(v: number, step: number) {
  const digits = (unit: number) => Math.min(3, Math.max(0, Math.ceil(-Math.log10(step / unit) - 1e-9)));

  if (v === 0) return "0";

  if (v < 1000) return v.toFixed(digits(1));

  return compact(digits(v >= 1e6 ? 1e6 : 1e3)).format(v);
}
