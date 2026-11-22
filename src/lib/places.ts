// Plain modules from @vado/server (they import nothing Workers-specific), typed for the page.
import * as regions from "@vado/server/replication/regions.js";
import * as slots from "@vado/server/protocol/slots.js";
import * as views from "@vado/server/admin/views.js";
import type { Place } from "./types";

/** Region (location hint) -> its name for people. */
export const REGION_NAMES: Record<string, string> = regions.REGION_NAMES;
/** The regions a database spreads over, in order. */
export const WORLD: string[] = regions.WORLD;
/** Regions whose Durable Objects Cloudflare runs in a nearby region instead. */
export const HOSTED_ELSEWHERE: Set<string> = regions.HOSTED_ELSEWHERE;
/** Hash slots a key can fall in. */
export const SLOTS: number = slots.SLOTS;

/** A Cloudflare location code as a place (null fields if unknown). */
export const place: (colo: string | null) => Place = views.place;
