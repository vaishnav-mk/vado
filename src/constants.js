// Tunables. Sizes are in bytes, times in milliseconds.

// ---- router (src/router.js) ----

/** Unacknowledged bytes on any hop, client or shard, before a router stops reading its client; it resumes below the low mark. */
export const ROUTER_HIGH_WATER = 1 << 20;
export const ROUTER_LOW_WATER = 256 << 10;
/**
 * All routers in an isolate share its 128 MB. Past ISOLATE_HIGH unacknowledged shard-bound bytes in
 * total, every router stops reading its client until they drain below ISOLATE_LOW. Shards always
 * read, so these drain on their own. Client-bound bytes don't count: they drain only if that client
 * reads, so counting them would let one stalled client pause every router in the isolate.
 */
export const ISOLATE_HIGH = 32 << 20;
export const ISOLATE_LOW = 16 << 20;
/**
 * Largest request (all its arguments) a router buffers: an 8 MB value plus its command. A 64 MB shard
 * in a 128 MB isolate can't take a much bigger one at once, since it needs the query buffer, the value
 * and the AOF buffer together. Before AUTH the cap is MAX_UNAUTHED, like Valkey's unauthenticated limits.
 */
export const MAX_REQUEST = (8 << 20) + (64 << 10);
export const MAX_UNAUTHED = 64 << 10;
/**
 * Shard sockets one isolate holds before new upstreams carry stateless batches over RPC instead: the
 * runtime drops sockets past a few hundred per isolate. `ROUTER_SOCKET_BUDGET` overrides it.
 */
export const SOCKET_BUDGET = 128;
/** A shard socket unused this long is closed, so idle shards stop being billed. `ROUTER_IDLE_MS` overrides it. */
export const IDLE_MS = 30_000;
/** Shards a fan-out command (SCAN, KEYS, DBSIZE, FLUSHALL, INFO) talks to at once. */
export const FAN_OUT = 32;
/** Bytes per RPC batch, well under the 32 MiB RPC message cap. */
export const RPC_BATCH_BYTES = 4 << 20;
/** A shard reply this late makes the router check whether the shard instance changed under it. */
export const PROBE_AFTER_MS = 5_000;
/** How long a shard may take to send its greeting; a cold shard boots for seconds first. */
export const GREETING_MS = 20_000;

// ---- shard host (src/valkey-host.js) ----

/**
 * A client whose replies are unacknowledged past CLIENT_HIGH_WATER stops being read, and so does every
 * client once the object holds SHARD_HIGH_WATER of them: with hundreds of busy connections,
 * per-connection limits alone can exceed the 128 MB isolate.
 */
export const CLIENT_HIGH_WATER = 256 << 10;
export const CLIENT_LOW_WATER = 64 << 10;
export const SHARD_HIGH_WATER = 16 << 20;
export const SHARD_LOW_WATER = 8 << 20;
/** Idle internal Valkey clients kept per RESP protocol for RPC batches. */
export const POOL_MAX = 64;

// ---- storage (src/vfs.js) ----

/** File bytes per SQLite row, under the 2 MB row cap. */
export const VFS_CHUNK = 1 << 20;
/**
 * The last row of a file grows in place while it is under this. Rows written are billed, so this
 * makes an AOF append one row, and a rewrite deletes one row per VFS_TAIL bytes instead of one per append.
 */
export const VFS_TAIL = 16 << 10;

// ---- WebSocket ingress (src/index.js) ----

/** WebSockets can't push back on the sender, so a client that outruns its router by this much is disconnected. */
export const WS_MAX_QUEUED = 16 << 20;
