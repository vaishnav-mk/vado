// The server's memory when BOX_MAXMEMORY is unset: half a standard-1 instance.
export const MAXMEMORY = "2gb";

// A boot that takes longer fails, and the next request boots a new container.
export const BOOT_MS = 600_000;

// A server that kept running answers at once; one that doesn't is replaced.
export const REUSE_MS = 10_000;

// Loading a stored copy, and a full sync.
export const READY_MS = 300_000;
export const LINK_MS = 300_000;

// A copy into the container that stops moving this long has failed.
export const STALL_MS = 15_000;

// A fresh container starts and listens for the copy within this.
export const LISTEN_MS = 30_000;

// A destroyed container exits within this.
export const STOP_MS = 30_000;

// A command on a connection of its own, and a replayed batch, answer within these.
export const ASK_MS = 5_000;
export const REPLAY_STALL_MS = 60_000;

export const POLL_MS = 50;

// A burst of new shards can outrun the instances ready; more arrive within a minute or two.
export const CAPACITY_MS = 180_000;
export const CAPACITY_RETRY_MS = 2_000;

// Fresh containers sometimes drop the copy or exit on a cut one: tries before a boot fails.
export const COPIES = 3;

// How often the engine checks for idleness and compaction.
export const TICK_MS = 10_000;

// Idle this long, a shard folds its stream and stops its container; the platform does it FOLD_MS later if the object
// was evicted first.
export const IDLE_MS = 10 * 60_000;
export const FOLD_MS = 5 * 60_000;

// A new generation once the stream outgrows its base, so storage and restores stay about one base in size.
export const COMPACT_MIN = 64 << 20;

// A delete holds every reply until it commits, so old generations go a batch at a time with a gap between.
export const PRUNE_BYTES = 8 << 20;
export const PRUNE_GAP_MS = 250;

// Pre-dialed server connections, so a new client doesn't wait for a dial.
export const SPARES = 4;

// The link's REPLCONF ACK interval; the server drops a silent replica.
export const ACK_MS = 1_000;

// How long a reply waits for the stream up to its writes to be stored.
export const FENCE_MS = 15_000;

// Stored RDB rows; at most two are uncommitted at once. A replay sends the stream in batches this size.
export const RDB_CHUNK = 1 << 20;
export const REPLAY_BATCH = 1 << 20;
