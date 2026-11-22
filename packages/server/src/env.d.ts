// Settings a deploy may add (wrangler secret or var) on top of the bindings in worker-configuration.d.ts.
interface Env {
  /** A bearer token that enables the bench API (bench/). */
  BENCH_TOKEN?: string;
  /** Where new objects are placed by default: a location hint. */
  LOCATION_HINT?: string;
  /** Shard counts for new databases by creation time, as JSON (catalog/epochs.ts). */
  SHARD_EPOCHS?: string;
  /** Shard sockets per isolate before new upstreams go over RPC (router/config.ts). */
  ROUTER_SOCKET_BUDGET?: string;
  /** How long an unused shard socket stays open, in ms (router/config.ts). */
  ROUTER_IDLE_MS?: string;
  VALKEY_LOGLEVEL?: string;
  VALKEY_MAXMEMORY?: string;
  VALKEY_MAXMEMORY_POLICY?: string;
}
