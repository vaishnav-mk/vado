// appendfsync always + the write-through Vfs: the output gate holds a reply until its AOF bytes are in SQLite.
export const valkeyArgs = (
  env: Pick<Env, "VALKEY_LOGLEVEL" | "VALKEY_MAXMEMORY" | "VALKEY_MAXMEMORY_POLICY">,
  replica: boolean,
): string[] => [
  "--port",
  "6379",
  "--bind",
  "127.0.0.1",
  "--protected-mode",
  "no",
  "--daemonize",
  "no",
  "--io-threads",
  "1",
  "--logfile",
  "",
  "--loglevel",
  env.VALKEY_LOGLEVEL || "warning",
  "--dir",
  "/data",
  "--save",
  "",
  ...(replica ? ["--appendonly", "no"] : ["--appendonly", "yes", "--appendfsync", "always", "--appenddirname", "aof"]),
  "--aof-use-rdb-preamble",
  "yes",
  "--aof-timestamp-enabled",
  "no",
  // No fork in wasm: the shard picks when to rewrite.
  "--auto-aof-rewrite-percentage",
  "0",
  // Latency tracking times each command, but the Workers clock doesn't move during one.
  "--latency-tracking",
  "no",
  // A replica must not fail a streamed write nobody sees; "3gb" is 0 in a 32-bit build, minus the boot warning.
  ...(replica ? ["--import-mode", "yes", "--maxmemory", "3gb"] : ["--maxmemory", env.VALKEY_MAXMEMORY || "64mb"]),
  "--maxmemory-policy",
  env.VALKEY_MAXMEMORY_POLICY || "noeviction",
  // The default 10 per cycle queued hundreds of RPC batches until callers gave up (seen at 96 x 4 load).
  "--max-new-connections-per-cycle",
  "1000",
];
