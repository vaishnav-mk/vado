import type { TestLevel } from "./live-types";

// An isolate that hasn't reported for this long has no open connections.
export const PULSE_STALE_MS = 10_000;

export const WATCH_MS = 1_000;

// Five minutes at WATCH_MS.
export const WATCH_HISTORY = 300;

// So one slow poll doesn't draw a spike.
export const WATCH_RATE_POLLS = 5;

// A page that missed more asks for a snapshot.
export const WATCH_REPLAY = 10;

export const EVENTS_KEPT = 100;

// The same text again within this long counts up instead of adding an event.
export const EVENT_REPEAT_MS = 60_000;

export const RESTARTING_MS = 10_000;

// Warn once above MEMORY_HIGH of maxmemory, and again only after dropping below MEMORY_OK.
export const MEMORY_HIGH = 0.9;
export const MEMORY_OK = 0.8;

export const PROBE_KEY = "dashboard:probe";
export const PROBE_STALL_MS = 5_000;

// So a forgotten test doesn't run up a bill.
export const TEST_TRAFFIC_MS = 10 * 60_000;

// Shared by all of a test's senders: about 8 MB of a shard's 64 MB.
export const TEST_KEYS_PER_SHARD = 50_000;

export const TEST_SENDERS: Record<TestLevel, number> = { light: 1, medium: 3, heavy: 6 };

export const WAIT_MS = 3_000;

export const COMMAND_STALL_MS = 15_000;
