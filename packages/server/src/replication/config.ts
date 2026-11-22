// Write bytes a replica may be behind (queued during its copy, or unacknowledged on its socket) before it is dropped
// and copied again. They count toward SHARD_HIGH_WATER too: below it, one stuck replica is dropped before it can
// stall the primary, while replicas that all lag slow the writes down (32 MB each over 9 ran a primary out of 128 MB).
export const REPL_BACKLOG = 8 << 20;

// How often a primary restarts failed replicas and sends each live one a marker that measures its lag.
export const REPL_TICK_MS = 2_000;

export const REPL_RETRY_MS = 5_000;

// A marker unanswered this long means the replica is stuck: it is dropped and copied again.
export const REPL_STUCK_MS = 60_000;

// A replica that stopped reading would otherwise hold its copy, and the AOF rewrites that wait for copies, forever.
// A 64 MB copy takes seconds.
export const REPL_COPY_MS = 5 * 60_000;

// With no client activity or writes for this long, and no reads of its replicas either, a primary retires its
// replicas and stops ticking, so an idle replicated database sleeps. Activity wakes it.
export const REPL_IDLE_MS = 10 * 60_000;

// After a connection writes to a shard, its reads of that shard go to the primary for this long.
export const READ_YOUR_WRITES_MS = 2_000;
