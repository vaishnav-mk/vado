import { useEffect, useState, useSyncExternalStore } from "react";

const media = (q: string) => ({
  subscribe: (f: () => void) => {
    const m = matchMedia(q);
    m.addEventListener("change", f);

    return () => m.removeEventListener("change", f);
  },
  get: () => matchMedia(q).matches,
});

const darkQuery = media("(prefers-color-scheme: dark)");
const calmQuery = media("(prefers-reduced-motion: reduce)");

export const useDark = () => useSyncExternalStore(darkQuery.subscribe, darkQuery.get, () => false);

export const useReducedMotion = () => useSyncExternalStore(calmQuery.subscribe, calmQuery.get, () => false);

// Ticks on its own so relative times move on when no data arrives.
export function useNow(every = 10_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);

    return () => clearInterval(t);
  }, [every]);

  return now;
}

export function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);

  const run = async <T>(f: () => Promise<T>) => {
    setBusy(true);
    setError(null);

    try {
      await f();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }

    setBusy(false);
  };

  return { busy, error, setError, run };
}
