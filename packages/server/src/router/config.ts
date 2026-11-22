// Router and WebSocket ingress tunables. Sizes are in bytes, times in milliseconds.

/** Unacknowledged bytes on any hop, client or shard, before a router stops reading its client; it resumes below the low mark. */
export const ROUTER_HIGH_WATER = 1 << 20;
export const ROUTER_LOW_WATER = 256 << 10;

// Every router in an isolate shares its 128 MB: past ISOLATE_HIGH shard-bound bytes in total, all of them stop reading
// their clients until it drains below ISOLATE_LOW. Client-bound bytes don't count: one stalled client would pause all.
export const ISOLATE_HIGH = 32 << 20;
export const ISOLATE_LOW = 16 << 20;

/** Largest request a router buffers: an 8 MB value plus its command. Before AUTH, Valkey's unauthenticated limit. */
export const MAX_REQUEST = (8 << 20) + (64 << 10);
export const MAX_UNAUTHED = 64 << 10;

/** Shard sockets per isolate before new upstreams go over RPC: the runtime drops sockets past a few hundred. `ROUTER_SOCKET_BUDGET` overrides it. */
export const SOCKET_BUDGET = 128;

/** A shard socket unused this long is closed, so idle shards stop being billed. `ROUTER_IDLE_MS` overrides it. */
export const IDLE_MS = 30_000;

/** Shards a fan-out command (SCAN, KEYS, DBSIZE, FLUSHALL, INFO) talks to at once. */
export const FAN_OUT = 32;

/** Bytes per RPC batch, well under the 32 MiB RPC message cap. */
export const RPC_BATCH_BYTES = 4 << 20;

/** How often each router checks its shard sockets (stalls, idle ones). */
export const WATCHDOG_MS = 1_000;

/** A reply this late makes the router ask whether the shard instance changed under it; each same answer doubles the wait (up to 16x). */
export const PROBE_AFTER_MS = 1_000;

/** A shard that closed a socket without running what was pending gets it again after this, doubling per try (about 5 s in all). */
export const REDIAL_MS = 10;
export const REDIALS = 9;

/** How long a shard may take to send its greeting; a cold shard boots for seconds first. */
export const GREETING_MS = 20_000;

/** How long a closing connection waits for replies still owed. */
export const DRAIN_MS = 60_000;

/** How often each isolate reports its open connections to the Pulse object. */
export const PULSE_MS = 2_000;

/** WebSockets can't push back on the sender, so a client that outruns its router by this much is disconnected. */
export const WS_MAX_QUEUED = 16 << 20;

/** A client on the "vado-acks" subprotocol says how much it has read; its router stops sending while this much is unacknowledged. */
export const WS_UNACKED = 8 << 20;
