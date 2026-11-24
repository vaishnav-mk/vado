import { WATCH_HISTORY, WATCH_MS } from "@vado/server/admin/config.ts";

export const CHART_WINDOW_MS = WATCH_HISTORY * WATCH_MS;
// Room for the five axis labels niceAxis makes (four steps) without crowding.

export const CHART_HEIGHT = 220;

// Degrees a second: a turn in 72 s, slow enough that arcs and dots stay readable.
export const GLOBE_SPIN = 5;
// The path is drawn by 2 × COMMAND_TRAVEL_MS; the rest is time to look at it.

export const COMMAND_PATH_MS = 6_000;
// Per leg, slow enough to see which way the command went.

export const COMMAND_TRAVEL_MS = 1_200;
export const MAX_STREAMS = 40; // more is a tangle, not information
// Every client talks to every shard, so past a few shard cities entry arcs join everything to everything.

export const MAX_ENTRY_TARGETS = 3;
// Only the busiest places get entry arcs; the rest still show as markers.

export const MAX_ENTRY_SOURCES = 8;

// Reads/s: below one read in the Watcher's rate window, so any read counts as serving.
export const SERVING_READS = 0.05;
