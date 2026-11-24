// Unacknowledged reply bytes that pause reading; per-client caps alone pass 128 MB with hundreds of busy clients.
export const CLIENT_HIGH_WATER = 256 << 10;
export const CLIENT_LOW_WATER = 64 << 10;
export const SHARD_HIGH_WATER = 16 << 20;
export const SHARD_LOW_WATER = 8 << 20;

// AOF commits in flight; more input waits for one, then runs in one pass. 2 measured best (1 serializes commits).
export const SHARD_COMMITS = 2;

// Idle internal clients kept per RESP protocol: reuse saves an accept, create, QUIT and free per RPC batch.
export const POOL_MAX = 64;

// How long drain waits for running batches, and later for sockets to close, before it goes on without them.
export const DRAIN_WAIT_MS = 5_000;
