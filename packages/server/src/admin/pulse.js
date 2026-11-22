// Live activity for the local view in ui/. Each isolate running routers reports its open connections
// every PULSE_MS, and the view reads the latest report of each. Kept in memory only: it's a view of
// now, not a record, and a reset loses one report interval.
import { DurableObject } from "cloudflare:workers";

const STALE_MS = 10_000; // an isolate that hasn't reported for this long has no open connections

export class Pulse extends DurableObject {
  #isolates = new Map(); // isolate id -> its last report

  report(r) {
    this.#isolates.set(r.isolate, { ...r, at: Date.now() });
  }

  snapshot() {
    const now = Date.now();

    for (const [k, r] of this.#isolates) if (now - r.at > STALE_MS) this.#isolates.delete(k);

    return { at: now, isolates: [...this.#isolates.values()] };
  }
}
