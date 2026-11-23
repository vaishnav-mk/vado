const compact = (digits: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: digits });

const C0 = compact(0),
  C1 = compact(1);

/** 0.4, 950, 1.2K, 34K, 1.5M */
export const num = (n: number | null | undefined) => {
  const v = n ?? 0;

  return v < 10
    ? `${Math.round(v * 10) / 10}`
    : v < 1000
      ? `${Math.round(v)}`
      : v < 10_000
        ? C1.format(v)
        : v < 1e6
          ? C0.format(v)
          : C1.format(v);
};

export const bytes = (b: number | null | undefined) => {
  const v = b ?? 0;

  return v >= 2 ** 30
    ? `${(v / 2 ** 30).toFixed(1)} GB`
    : v >= 2 ** 20
      ? `${(v / 2 ** 20).toFixed(1)} MB`
      : v >= 1024
        ? `${Math.round(v / 1024)} KB`
        : `${Math.round(v)} B`;
};

/** "8.6 of 64 MB": both in the unit of the larger. */
export function bytesOf(used: number | null | undefined, max: number | null | undefined) {
  const u = used ?? 0,
    m = max ?? 0,
    [div, unit] = m >= 2 ** 30 ? [2 ** 30, "GB"] : m >= 2 ** 20 ? [2 ** 20, "MB"] : [1024, "KB"];

  const f = (v: number) => (v / div >= 10 ? `${Math.round(v / div)}` : `${Number((v / div).toFixed(1))}`);

  return `${f(u)} of ${f(m)} ${unit}`;
}

export const duration = (s: number) =>
  s < 60
    ? `${Math.max(0, Math.round(s))} s`
    : s < 3600
      ? `${Math.round(s / 60)} min`
      : s < 86400
        ? `${(s / 3600).toFixed(1)} h`
        : `${Math.round(s / 86400)} d`;

export const ms = (v: number | null | undefined) =>
  v === null || v === undefined ? "–" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;

export const plural = (n: number, word: string, many = `${word}s`) =>
  `${n.toLocaleString("en")} ${n === 1 ? word : many}`;

export const clock = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const dateTime = (t: number) => new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });

/** "just now", "40 s ago", "2 min ago", "3 h ago" */
export function ago(t: number, now: number) {
  const s = (now - t) / 1000;

  return s < 5
    ? "just now"
    : s < 60
      ? `${Math.round(s)} s ago`
      : s < 3600
        ? `${Math.round(s / 60)} min ago`
        : s < 86400
          ? `${Math.round(s / 3600)} h ago`
          : `${Math.round(s / 86400)} d ago`;
}

/** "Frankfurt, Paris and 3 more" */
export const cities = (xs: string[]) =>
  xs.length > 3
    ? `${xs.slice(0, 3).join(", ")} and ${xs.length - 3} more`
    : xs.length > 1
      ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`
      : (xs[0] ?? "");

/**
 * A y axis from 0 with about four steps of 1, 2 or 5 times a power of ten (at least `minStep`), so labels
 * are never repeated. Returns the top and the step.
 */
export function niceAxis(max: number, minStep = 1, steps = 4) {
  const raw = (max > 0 ? max : 1) / steps;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(minStep, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);

  return { max: Math.max(step, Math.ceil(max / step - 1e-9) * step), step };
}

/** An axis label at a multiple of `step` (from niceAxis): compact, with just enough decimals. */
export function axisLabel(v: number, step: number) {
  const digits = (unit: number) => Math.min(3, Math.max(0, Math.ceil(-Math.log10(step / unit) - 1e-9)));

  if (v === 0) return "0";

  if (v < 1000) return v.toFixed(digits(1));

  return compact(digits(v >= 1e6 ? 1e6 : 1e3)).format(v);
}
