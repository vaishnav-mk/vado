// Below SHARD_HIGH_WATER, so one stuck replica is dropped before it stalls the primary (32 MB x 9 ran out of 128 MB).
export const REPL_BACKLOG = 8 << 20;

// How often a primary restarts failed replicas and sends each live one a marker that measures its lag.
export const REPL_TICK_MS = 2_000;

export const REPL_RETRY_MS = 5_000;

// A marker unanswered this long means the replica is stuck: it is dropped and copied again.
export const REPL_STUCK_MS = 60_000;

// A stuck copy would hold off AOF rewrites forever; a 64 MB copy takes seconds.
export const REPL_COPY_MS = 5 * 60_000;

// Then an idle primary retires its replicas and stops ticking, so an idle replicated database can sleep.
export const REPL_IDLE_MS = 10 * 60_000;

// After a connection writes to a shard, its reads of that shard go to the primary for this long.
export const READ_YOUR_WRITES_MS = 2_000;
