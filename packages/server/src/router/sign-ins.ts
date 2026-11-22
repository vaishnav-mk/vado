// Failed AUTHs per client address, counted in each Cloudflare location by the AUTH_LIMIT rate limiter. Past its limit
// an address may not AUTH for a minute, so nobody guesses passwords or database names (each unknown name asks the
// catalog) at speed. The block is kept per isolate too, so a blocked client costs nothing.
import type { SignIns, Where } from "./types";

// client IP -> blocked until (ms)
const blockedUntil = new Map<string, number>();
const BLOCK_MS = 60_000;
const MAX_BLOCKED = 10_000;

/** The IP in a socket address: "[v6]:port", "v4:port", or as it is. */
export function ipOf(addr: string | null | undefined): string | null {
  if (!addr) return null;

  if (addr.startsWith("[")) return addr.slice(1, addr.indexOf("]"));

  return /^[\d.]+:\d+$/.test(addr) ? addr.slice(0, addr.lastIndexOf(":")) : addr;
}

export function signIns(env: Env, where: Where | null): SignIns | null {
  const ip = ipOf(where?.addr);

  if (!ip) return null;

  return {
    blocked: () => (blockedUntil.get(ip) ?? 0) > Date.now(),
    failed: () => {
      void env.AUTH_LIMIT.limit({ key: ip }).then(
        ({ success }) => {
          if (success) return;
          const now = Date.now();

          if (blockedUntil.size > MAX_BLOCKED) for (const [k, t] of blockedUntil) if (t <= now) blockedUntil.delete(k);
          blockedUntil.set(ip, now + BLOCK_MS);
        },
        () => {},
      );
    },
  };
}
