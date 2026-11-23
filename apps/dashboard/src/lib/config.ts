import { WATCH_HISTORY, WATCH_MS } from "@vado/server/admin/config.ts";

export { EVENTS_KEPT, RESTARTING_MS, WATCH_HISTORY } from "@vado/server/admin/config.ts";

export const CHART_WINDOW_MS = WATCH_HISTORY * WATCH_MS;
export const CHART_HEIGHT = 220;

export const GLOBE_SPIN = 5;
export const COMMAND_PATH_MS = 6_000;
export const COMMAND_TRAVEL_MS = 1_200;
export const MAX_STREAMS = 40; // more is a tangle, not information
export const MAX_ENTRY_ARCS = 3;

export const SERVING_READS = 0.05;
