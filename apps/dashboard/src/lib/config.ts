import { WATCH_HISTORY, WATCH_MS } from "@vado/server/admin/config.ts";

export { EVENTS_KEPT, RESTARTING_MS, WATCH_HISTORY } from "@vado/server/admin/config.ts";

export const CHART_WINDOW_MS = WATCH_HISTORY * WATCH_MS; // the Watcher's whole history
export const CHART_HEIGHT = 220;

export const GLOBE_SPIN = 5; // degrees per second
export const COMMAND_PATH_MS = 6_000; // how long the last command's path stays on the globe
export const COMMAND_TRAVEL_MS = 1_200; // how long its dot takes to cross
export const MAX_STREAMS = 40; // the busiest streams of writes; more is a tangle, not information
export const MAX_ENTRY_ARCS = 3; // traffic arcs only for a database whose shards live in this many places or fewer

export const SERVING_READS = 0.05; // reads/s above which a replica counts as serving reads right now
