import { useEffect, useState, useSyncExternalStore } from "react";

const media = (q: string) => ({
  subscribe: (f: () => void) => { const m = matchMedia(q); m.addEventListener("change", f); return () => m.removeEventListener("change", f); },
  get: () => matchMedia(q).matches,
});
const darkQuery = media("(prefers-color-scheme: dark)");
const calmQuery = media("(prefers-reduced-motion: reduce)");

/** Whether the system is in dark mode (false while rendering on the server). */
export const useDark = () => useSyncExternalStore(darkQuery.subscribe, darkQuery.get, () => false);

/** Whether the person asked for less motion. */
export const useReducedMotion = () => useSyncExternalStore(calmQuery.subscribe, calmQuery.get, () => false);

/** Date.now(), refreshed every `every` ms, so relative times move on even when no data arrives. */
export function useNow(every = 10_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), every); return () => clearInterval(t); }, [every]);
  return now;
}
