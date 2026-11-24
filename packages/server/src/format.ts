// Numbers and lists as the dashboard and the watcher's events show them. Runs in the browser too.

export const compact = (digits: number) =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: digits });

const C0 = compact(0),
  C1 = compact(1);

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

// "a, b and c", or "a, b, c and 4 more" past `max`.
export const list = (xs: readonly (string | number)[], max = 3) =>
  xs.length > max
    ? `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`
    : xs.length > 1
      ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`
      : String(xs[0] ?? "");

// `part` as a percentage of `whole`, at most 100; null without a whole.
export const share = (part: number, whole: number | null | undefined) =>
  whole ? Math.min(100, (100 * part) / whole) : null;
