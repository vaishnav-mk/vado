// Where things run: location hints, the regions a database can use, and the region of each Cloudflare colo, so a
// router can find the replica in its region. Browser-safe: the dashboard imports it.
import type { Hint } from "../catalog/types";
import colos from "./colos.json";

const HINT_LIST = [
  "wnam",
  "enam",
  "sam",
  "weur",
  "eeur",
  "apac",
  "apac-ne",
  "apac-se",
  "oc",
  "afr",
  "me",
] as const satisfies readonly Hint[];

/** Durable Object location hints. A database may spread its shards over several (`regions`). */
export const HINTS: ReadonlySet<string> = new Set(HINT_LIST);

export const isHint = (name: string): name is Hint => HINTS.has(name);

/** One shard per region in turn, for a database spread around the world. */
export const WORLD: Hint[] = ["wnam", "enam", "sam", "weur", "eeur", "me", "afr", "apac", "oc"];

/** Hints Cloudflare accepts but has no Durable Objects in yet: objects hinted there run in a nearby region instead
 *  (South America in eastern North America, say). https://developers.cloudflare.com/durable-objects/reference/data-location/ */
export const HOSTED_ELSEWHERE: ReadonlySet<string> = new Set(["sam", "afr", "me"]);

/** Region names by hint; indexed with any string, so a missing one reads as undefined. */
export interface RegionNames {
  readonly [hint: string]: string;
}

/** What each region is called, for people. */
export const REGION_NAMES: RegionNames = {
  wnam: "Western North America",
  enam: "Eastern North America",
  sam: "South America",
  weur: "Western Europe",
  eeur: "Eastern Europe",
  me: "Middle East",
  afr: "Africa",
  apac: "Asia Pacific",
  oc: "Oceania",
};

/** Colo (IATA code) to its region, from colos.json; unknown colos read from the primary. */
export const REGION_OF = new Map<string, Hint>();

for (const [colo, entry] of Object.entries(colos)) {
  const hint = String(entry[3]);

  if (isHint(hint)) REGION_OF.set(colo, hint);
}

let colo: string | null = null;

/** The colo this code runs in, from Cloudflare's trace endpoint (once per isolate); null if it doesn't say. Rejects
 *  if the endpoint can't be reached (offline dev). */
export async function coloOf(): Promise<string | null> {
  if (colo !== null) return colo;
  const text = await (await fetch("https://cloudflare.com/cdn-cgi/trace")).text();
  colo = /^colo=(\w+)$/m.exec(text)?.[1] ?? null;

  return colo;
}
