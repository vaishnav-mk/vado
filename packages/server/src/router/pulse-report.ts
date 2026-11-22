// What this isolate reports to the Pulse object: its colo and open connections.
import { coloOf } from "../replication/regions";
import { PULSE_MS } from "./config";
import type { RouterView, Via, Where } from "./types";

export interface LiveConn {
  id: string;
  db: string;
  via: Via;
  where: Where | null;
  since: number;
  router: RouterView | null;
}

export interface Live {
  isolate: string | null;
  colo: string | null;
  coloTried: number;
  conns: Map<string, LiveConn>;
  flushed: number;
  /** Commands of connections that have closed, per database, so short connections count too. */
  done: Record<string, number>;
}

// Isolate-wide, so one report covers every connection here.
export const live: Live = { isolate: null, colo: null, coloTried: 0, conns: new Map(), flushed: 0, done: {} };

const COLO_RETRY_MS = 10_000;

export function learnColo(): void {
  const now = Date.now();

  if (live.colo || now - live.coloTried < COLO_RETRY_MS) return;
  live.coloTried = now;
  coloOf().then(
    (colo) => {
      live.colo ??= colo;
    },
    () => {},
  );
}

/** Sends the report, unless one went less than `minGap` ago. Each connection reports from its own timer, so no
 *  request does I/O on behalf of another. */
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

  live.isolate ??= crypto.randomUUID();
  pulse.report({ isolate: live.isolate, colo: live.colo, conns, done: live.done }).catch(() => {});
}
