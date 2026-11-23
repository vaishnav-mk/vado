interface Env {
  BENCH_TOKEN?: string;
  LOCATION_HINT?: string;
  SHARD_EPOCHS?: string;
  ROUTER_SOCKET_BUDGET?: string;
  ROUTER_IDLE_MS?: string;
  VALKEY_LOGLEVEL?: string;
  VALKEY_MAXMEMORY?: string;
  BOX?: string; // "1" in builds with the container application (VADO_CONTAINERS=1)
  BOX_MAXMEMORY?: string;
  VALKEY_MAXMEMORY_POLICY?: string;
}
