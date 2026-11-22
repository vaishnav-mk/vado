import { WATCH_RATE_POLLS } from "../config";
import type { Entry } from "../live-types";
import type { PulseSnapshot } from "../types";
import { place } from "../views";
import { keep, rate } from "./state";

/** Where clients connect: each router isolate's commands per second on one database, summed per colo. */
export class Entries {
  #isolates = new Map<string, { at: number; commands: number }[]>();

  clear(): void {
    this.#isolates.clear();
  }

  see(isolates: PulseSnapshot["isolates"], db: string): Entry[] {
    const byColo = new Map<string | null, { ops: number; conns: number }>(),
      seen = new Set<string>();

    for (const iso of isolates) {
      seen.add(iso.isolate);
      const conns = iso.conns.filter((c) => c.db === db);
      const commands = (iso.done[db] ?? 0) + conns.reduce((a, c) => a + c.commands, 0);
      const points = this.#isolates.get(iso.isolate) ?? [];

      if (points.at(-1)?.at !== iso.at) keep(points, { at: iso.at, commands }, WATCH_RATE_POLLS);
      this.#isolates.set(iso.isolate, points);
      const ops = rate(points, "commands");

      if (!conns.length && !ops) continue;
      const e = byColo.get(iso.colo) ?? { ops: 0, conns: 0 };
      e.ops += ops;
      e.conns += conns.length;
      byColo.set(iso.colo, e);
    }

    for (const id of this.#isolates.keys()) if (!seen.has(id)) this.#isolates.delete(id);

    return byColo
      .entries()
      .map(([colo, e]) => ({ ...place(colo), ops: e.ops, conns: e.conns }))
      .filter((e) => Boolean(e.city)) // a colo without a city can't be drawn
      .toArray();
  }
}
