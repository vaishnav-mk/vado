// Blocks guessing of passwords and database names (each unknown name asks the catalog). Blocks are kept per isolate,
// and decided by the AUTH_LIMIT rate limiter, which every failure calls.
import type { SignIns, Where } from "./types";
import { noop } from "../shared";
import { BLOCK_MS, MAX_BLOCKED } from "./config";

const blockedUntil = new Map<string, number>();

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
      void env.AUTH_LIMIT.limit({ key: ip }).then(({ success }) => {
        if (success) return;
        const now = Date.now();

        if (blockedUntil.size > MAX_BLOCKED) for (const [k, t] of blockedUntil) if (t <= now) blockedUntil.delete(k);
        blockedUntil.set(ip, now + BLOCK_MS);
      }, noop);
    },
  };
}
