// A client with this many unacknowledged reply bytes stops being read, and so does every client once the object
// holds SHARD_HIGH_WATER: with hundreds of busy connections, per-connection limits alone can exceed 128 MB.
export const CLIENT_HIGH_WATER = 256 << 10;
export const CLIENT_LOW_WATER = 64 << 10;
export const SHARD_HIGH_WATER = 16 << 20;
export const SHARD_LOW_WATER = 8 << 20;

// AOF commits in flight; more input waits for one, then runs in one pass. 2 measured best (1 serializes commits).
export const SHARD_COMMITS = 2;

// Idle internal clients kept per RESP protocol: reuse saves an accept, create, QUIT and free per RPC batch.
export const POOL_MAX = 64;
