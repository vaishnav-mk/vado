// A rewrite is due once the incr file is this big and at least as big as the base, as Valkey's default rule.
export const AOF_REWRITE_MIN = 8 << 20;

// Without a rewriter a due rewrite runs inline and blocks every client, so it waits for this much quiet.
export const AOF_REWRITE_IDLE_MS = 1_000;

// Rewrite anyway at this incr size (and twice the base), quiet or not: a restart replays the incr file (~1 s/64 MB).
export const AOF_REWRITE_CAP = 64 << 20;

// How often a shard that is appending looks at its AOF size.
export const AOF_CHECK_MS = 2_000;

// A rewriter that takes longer fails; after a failure the shard rewrites inline for AOF_REWRITER_RETRY_MS.
export const AOF_REWRITER_TIMEOUT_MS = 120_000;
export const AOF_REWRITER_RETRY_MS = 600_000;

// The runtime moves an object with open sockets to new code only by resetting it minutes later, so check this often.
export const VERSION_CHECK_MS = 30_000;

// Restarts per deploy: one soon after a deploy can come back on the old code while the deploy spreads.
export const UPGRADE_TRIES = 3;

// How long a restart waits for RPCs that are running commands.
export const UPGRADE_RPC_WAIT_MS = 5_000;

// Objects of one class on one machine can share an isolate; shard i of a new database uses class i % SHARD_CLASSES.
export const SHARD_CLASSES = 8;
