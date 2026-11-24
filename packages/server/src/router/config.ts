// Unacknowledged bytes on any hop before a router stops reading its client; it resumes below the low mark.
export const ROUTER_HIGH_WATER = 1 << 20;
export const ROUTER_LOW_WATER = 256 << 10;

// Shard-bound bytes across the isolate's 128 MB; client-bound ones don't count, or one stalled client would pause all.
export const ISOLATE_HIGH = 32 << 20;
export const ISOLATE_LOW = 16 << 20;

// An 8 MB value plus its command; before AUTH, Valkey's unauthenticated limit.
export const MAX_REQUEST = (8 << 20) + (64 << 10);
export const MAX_UNAUTHED = 64 << 10;

// Sockets per isolate before new upstreams use RPC: the runtime drops sockets past a few hundred.
export const SOCKET_BUDGET = 128;

// Idle shard sockets close so idle shards stop being billed.
export const IDLE_MS = 30_000;

// Shards one fan-out command talks to at once.
export const FAN_OUT = 32;

// Well under the 32 MiB RPC message cap.
export const RPC_BATCH_BYTES = 4 << 20;

// How often a router checks its shard sockets for stalls and idleness.
export const WATCHDOG_MS = 1_000;

// A reply this late makes the router ask if the shard instance changed; each same answer doubles it, up to 16x.
export const PROBE_AFTER_MS = 1_000;

// Resend backoff after a shard closes a socket unrun, doubling per try: about 5 s in all.
export const REDIAL_MS = 10;
export const REDIALS = 9;

// A cold shard boots for seconds before its greeting.
export const GREETING_MS = 20_000;

// How long a closing connection waits for replies still owed.
export const DRAIN_MS = 60_000;

// How often an isolate reports its open connections to Pulse.
export const PULSE_MS = 2_000;

// WebSockets can't push back, so a client that outruns its router by this much is disconnected.
export const WS_MAX_QUEUED = 16 << 20;

// With "vado-acks", the router stops sending while this much is unacknowledged.
export const WS_UNACKED = 8 << 20;

// How long a failed sign-in blocks its address, and how many addresses one isolate remembers.
export const BLOCK_MS = 60_000;

export const MAX_BLOCKED = 10_000;

export const COLO_RETRY_MS = 10_000;

// A socket whose write failed is dead unless its read side ends by then (it may still hold a restart marker).
export const WRITE_FAILED_MS = 2_000;

// After a connection writes to a shard, its reads of that shard go to the primary for this long.
export const READ_YOUR_WRITES_MS = 2_000;
