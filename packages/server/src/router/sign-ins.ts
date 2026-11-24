import type { SignIns, Where } from "./types";
import { noop } from "../shared";
import { BLOCK_MS, MAX_BLOCKED } from "./config";

const blockedUntil = new Map<string, number>();

export function ipOf(addr: string | null | undefined): string | null {
  if (!addr) return null;

  if (addr.startsWith("[")) return addr.slice(1, addr.indexOf("]"));

  return /^[\d.]+:\d+$/.test(addr) ? addr.slice(0, addr.lastIndexOf(":")) : addr;
}

// Unknown names count as failures too: each one costs a catalog lookup.
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
