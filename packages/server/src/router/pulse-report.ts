import { coloOf } from "../catalog/regions";
import { COLO_RETRY_MS, PULSE_MS } from "./config";
import type { Live } from "./types";
import { isolate } from "../shard/stats";
import { noop } from "../shared";

export const live: Live = { colo: null, coloTried: 0, conns: new Map(), flushed: 0, done: {} };

export function learnColo(): void {
  const now = Date.now();

  if (live.colo || now - live.coloTried < COLO_RETRY_MS) return;
  live.coloTried = now;
  coloOf().then((colo) => {
    live.colo ??= colo;
  }, noop);
}

// Each connection reports from its own timer, so no request does I/O on behalf of another.
export function report(env: Env, minGap = PULSE_MS): void {
  const now = Date.now();

  if (now - live.flushed < minGap) return;
  live.flushed = now;

  const conns = [...live.conns.values()].map(({ router, ...c }) => ({
    ...c,
    db: router?.db.name ?? c.db,
    commands: router?.commands ?? 0,
  }));

  const pulse = env.PULSE.getByName("pulse");

  pulse.report({ isolate: isolate(), colo: live.colo, conns, done: live.done }).catch(noop);
}
