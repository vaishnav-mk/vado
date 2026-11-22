// Tunables. Sizes are in bytes, times in milliseconds.

// ---- router (src/router/router.js) ----

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

/** How often each router checks its shard sockets (stalls, idle ones). */
export const WATCHDOG_MS = 1_000;

/**
 * A shard reply this late makes the router check whether the shard instance changed under it: a reset can leave
 * the socket open but dead. Each check that finds the same instance doubles the wait for the next (up to 16x),
 * so a long blocking command isn't checked every second.
 */
export const PROBE_AFTER_MS = 1_000;

/**
 * A shard that closes a router's socket without running what is pending on it (restarting onto new code, or
 * closing before its greeting) gets it again on a new socket, after this, doubling per try, up to REDIALS tries
 * (about 5 s in all). An RPC batch the shard refused while restarting is retried the same way.
 */
export const REDIAL_MS = 10;
export const REDIALS = 9;

/** How long a shard may take to send its greeting; a cold shard boots for seconds first. */
export const GREETING_MS = 20_000;

// ---- shard host (src/shard/valkey-host.js) ----

/**
 * A client whose replies are unacknowledged past CLIENT_HIGH_WATER stops being read, and so does every
 * client once the object holds SHARD_HIGH_WATER of them: with hundreds of busy connections,
 * per-connection limits alone can exceed the 128 MB isolate.
 */
export const CLIENT_HIGH_WATER = 256 << 10;
export const CLIENT_LOW_WATER = 64 << 10;
export const SHARD_HIGH_WATER = 16 << 20;
export const SHARD_LOW_WATER = 8 << 20;

/**
 * AOF commits a shard keeps in flight. More input waits for one to finish and then runs in one pass, so under
 * load a commit carries ~100 writes instead of ~4 (5x the SETs/s through the router, 30x fewer rows written).
 * 2 measured best: 1 serializes commits, 4 batches less.
 */
export const SHARD_COMMITS = 2;

// Shard classes: objects of one class on one machine can share an isolate (one memory limit, one thread);
// objects of different classes never do. Shard i of a new database uses class i % SHARD_CLASSES.
export const SHARD_CLASSES = 8;

/** Idle internal Valkey clients kept per RESP protocol for RPC batches. */
export const POOL_MAX = 64;

// ---- storage (src/shard/vfs.js) ----

/** File bytes per SQLite row, under the 2 MB row cap. */
export const VFS_CHUNK = 1 << 20;

/**
 * The last row of a file grows in place while it is under this. Rows written are billed, so this
 * makes an AOF append one row, and a rewrite deletes one row per VFS_TAIL bytes instead of one per append.
 */
export const VFS_TAIL = 16 << 10;

// Deleted files' chunks are removed about VFS_SWEEP_BYTES at a time, every VFS_SWEEP_MS, so no single
// storage commit frees (and makes SQLite move the pages after) a whole file, and the deletes ride along
// with the shard's own commits instead of adding their own.
export const VFS_SWEEP_BYTES = 2 << 20;
export const VFS_SWEEP_MS = 50;

// ---- AOF rewrites (src/shard/shard.js) ----

/** A rewrite is due once the incr file is this big and at least as big as the base, as Valkey's default rule. */
export const AOF_REWRITE_MIN = 8 << 20;

/** With no rewriter helper (src/shard/rewriter.js), a due rewrite runs inline and blocks every client, so it waits
 *  for the shard to be quiet this long. A helper rewrite doesn't block the shard and doesn't wait. */
export const AOF_REWRITE_IDLE_MS = 1_000;

/**
 * Rewrite anyway once the incr file reaches this (and twice the base), quiet or not: a restart replays the incr
 * file (~1 s per 64 MB). Only an inline rewrite blocks the shard while it runs.
 */
export const AOF_REWRITE_CAP = 64 << 20;

/** How often a shard that is appending looks at its AOF size. */
export const AOF_CHECK_MS = 2_000;

// A rewrite by a ValkeyRewriter (src/shard/rewriter.js) that takes longer than this fails; after a failure the
// shard rewrites inline (blocking, at quiet moments) for AOF_HELPER_RETRY_MS before trying a helper again.
export const AOF_HELPER_TIMEOUT_MS = 120_000;
export const AOF_HELPER_RETRY_MS = 600_000;

// ---- read replicas (src/replication/replication.js) ----

/**
 * Write bytes a replica may be behind (queued during its copy, or unacknowledged on its socket) before it is
 * dropped and copied again. Replication bytes also count toward SHARD_HIGH_WATER, which pauses client input:
 * with this below it, one stuck replica is dropped before it can stall the primary, while replicas that all
 * lag slow the writes down instead (32 MB each over 9 replicas ran a primary out of its 128 MB).
 */
export const REPL_BACKLOG = 8 << 20;

/** How often a primary checks its replicas: restarts failed ones, and sends a marker that measures how far behind each one is. */
export const REPL_TICK_MS = 2_000;

/** A replica that fails waits this long before it is copied again. */
export const REPL_RETRY_MS = 5_000;

/** A marker unanswered this long means the replica is stuck; it is dropped and copied again. */
export const REPL_STUCK_MS = 60_000;

/** A copy still running after this long is dropped and tried again: a replica that stopped reading would
 *  otherwise hold it, and the AOF rewrites that wait for copies, forever. A 64 MB copy takes seconds. */
export const REPL_COPY_MS = 5 * 60_000;

// A primary with no client activity or writes for this long, whose replicas haven't been read for this long
// either, retires its replicas and stops its alarm, so an idle replicated database sleeps. Activity wakes it.
export const REPL_IDLE_MS = 10 * 60_000;

/**
 * How often a busy shard asks whether newer code is deployed (its rewriter object, which runs the newest code once
 * idle). The runtime moves an object with open sockets to new code only by resetting it, minutes after a deploy,
 * cutting off commands in flight; a shard that sees newer code restarts itself first, cleanly. Routers of the new
 * code say so when they connect, so this matters only to databases whose clients keep their connections.
 */
export const VERSION_CHECK_MS = 30_000;

/** When this code was deployed (its Worker version's timestamp), or 0 if unknown. Routers put theirs in the address
 *  they dial ("router-<ms>:6379"), which also says they understand the restart marker (Upstream in router.js), and
 *  primaries in their replication dial ("repl-<ms>:6379"). */
export const deployedAt = (env) => Date.parse(env.VERSION?.timestamp ?? "") || 0;

/** What a restarting shard's RPCs throw, before running anything: the router tries again. */
export const RESTARTING = "shard restarting onto newer code";

/** After a connection writes to a shard, its reads of that shard go to the primary for this long, so it reads its own writes. */
export const READ_YOUR_WRITES_MS = 2_000;

// ---- live view (src/router/serve.js, src/admin/pulse.js) ----

/** How often each isolate reports its open connections to the Pulse object, when a PULSE binding exists. */
export const PULSE_MS = 2_000;

// ---- WebSocket ingress (src/router/websocket.js) ----

/** WebSockets can't push back on the sender, so a client that outruns its router by this much is disconnected. */
export const WS_MAX_QUEUED = 16 << 20;

/** Nor can a Worker see what a client has read, so a client on the "vado-acks" subprotocol says how much it has,
 *  and its router stops sending (and so reading its requests) while this much is unacknowledged. */
export const WS_UNACKED = 8 << 20;

// ---- the dashboard's live numbers (src/admin/watcher.js) and test traffic (src/bench/sender.js) ----

/** How often a Watcher polls its database's shards and replicas, while anyone is watching. */
export const WATCH_MS = 1_000;

/** Points of history a Watcher keeps for its charts: five minutes at WATCH_MS. */
export const WATCH_HISTORY = 300;

/** Rates are taken over this many polls, so one slow poll doesn't draw a spike. */
export const WATCH_RATE_POLLS = 5;

/** Test traffic stops by itself after this long, so a forgotten test doesn't run up a bill. */
export const TEST_TRAFFIC_MS = 10 * 60_000;

/** Test keys per shard, shared by all of a test's senders: about 8 MB of a shard's 64 MB. */
export const TEST_KEYS_PER_SHARD = 50_000;
