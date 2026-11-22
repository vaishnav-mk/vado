// Live activity: each isolate running routers reports its open connections, and a Watcher reads the latest of each.
// Memory only: a reset loses one report interval.
import { DurableObject } from "cloudflare:workers";
import { PULSE_STALE_MS } from "./config";
import type { IsolateReport, PulseSnapshot } from "./types";

export class Pulse extends DurableObject<Env> {
  #isolates = new Map<string, IsolateReport & { at: number }>();

  report(r: IsolateReport): void {
    this.#isolates.set(r.isolate, { ...r, at: Date.now() });
  }

  snapshot(): PulseSnapshot {
    const now = Date.now();

    for (const [k, r] of this.#isolates) if (now - r.at > PULSE_STALE_MS) this.#isolates.delete(k);

    return { at: now, isolates: [...this.#isolates.values()] };
  }
}
