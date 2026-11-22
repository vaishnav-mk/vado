import type { TestLevel } from "./live-types";

/** An isolate that hasn't reported for this long has no open connections. */
export const PULSE_STALE_MS = 10_000;

/** How often a Watcher polls its database's shards and replicas, while anyone is watching. */
export const WATCH_MS = 1_000;

/** Points of history a Watcher keeps for its charts: five minutes at WATCH_MS. */
export const WATCH_HISTORY = 300;

/** Rates are taken over this many polls, so one slow poll doesn't draw a spike. */
export const WATCH_RATE_POLLS = 5;

/** Ticks kept for a page that reconnects; one that missed more asks for a snapshot. */
export const WATCH_REPLAY = 10;

export const EVENTS_KEPT = 100;

/** The same event text again within this long counts up instead of adding an event. */
export const EVENT_REPEAT_MS = 60_000;

/** A shard counts as restarting for this long after it comes back. */
export const RESTARTING_MS = 10_000;

/** Warn once above MEMORY_HIGH of maxmemory, and again only after dropping below MEMORY_OK. */
export const MEMORY_HIGH = 0.9;
export const MEMORY_OK = 0.8;

export const PROBE_KEY = "dashboard:probe";
export const PROBE_STALL_MS = 5_000;

/** Test traffic stops by itself after this long, so a forgotten test doesn't run up a bill. */
export const TEST_TRAFFIC_MS = 10 * 60_000;

/** Test keys per shard, shared by all of a test's senders: about 8 MB of a shard's 64 MB. */
export const TEST_KEYS_PER_SHARD = 50_000;

/** Senders per region, by level. */
export const TEST_SENDERS: Record<TestLevel, number> = { light: 1, medium: 3, heavy: 6 };

/** How long a write from the dashboard waits to hear from its replicas. */
export const WAIT_MS = 3_000;

export const COMMAND_STALL_MS = 15_000;
