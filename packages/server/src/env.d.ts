interface Env {
  BENCH_TOKEN?: string;
  LOCATION_HINT?: string;
  SHARD_EPOCHS?: string;
  ROUTER_SOCKET_BUDGET?: string;
  ROUTER_IDLE_MS?: string;
  VALKEY_LOGLEVEL?: string;
  VALKEY_MAXMEMORY?: string;
  BOX?: string; // the servers the build has container images of, "valkey" or "valkey,redis" (VADO_CONTAINERS=1)
  BOX_MAXMEMORY?: string;
  VALKEY_MAXMEMORY_POLICY?: string;
}
