// Browser-safe: the dashboard imports it.
import type { Hint } from "./types";
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

export const HINTS: ReadonlySet<string> = new Set(HINT_LIST);

// For messages that list the valid regions.
export const HINT_NAMES = HINT_LIST.join(", ");

export const isHint = (name: string): name is Hint => HINTS.has(name);

export const WORLD: Hint[] = ["wnam", "enam", "sam", "weur", "eeur", "me", "afr", "apac", "oc"];

// Accepted hints with no Durable Objects yet: https://developers.cloudflare.com/durable-objects/reference/data-location/
export const HOSTED_ELSEWHERE: ReadonlySet<string> = new Set(["sam", "afr", "me"]);

export interface RegionNames {
  readonly [hint: string]: string;
}

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

export const regionName = (region: string): string => REGION_NAMES[region] ?? region;

export const REGION_OF = new Map<string, Hint>();

for (const [colo, entry] of Object.entries(colos)) {
  const hint = String(entry[3]);

  if (isHint(hint)) REGION_OF.set(colo, hint);
}

let colo: string | null = null;

// Rejects if the endpoint can't be reached (offline dev).
export async function coloOf(): Promise<string | null> {
  if (colo !== null) return colo;
  const text = await (await fetch("https://cloudflare.com/cdn-cgi/trace")).text();
  colo = /^colo=(\w+)$/m.exec(text)?.[1] ?? null;

  return colo;
}
