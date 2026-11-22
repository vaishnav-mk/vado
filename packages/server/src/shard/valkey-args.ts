// Valkey's own config (Redis takes the same). appendfsync always + the write-through Vfs: a reply leaves only after
// the AOF bytes behind it are in SQLite (the output gate holds it until then).
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
  // A replica keeps its data in memory only: its primary copies it again after a reset.
  ...(replica ? ["--appendonly", "no"] : ["--appendonly", "yes", "--appendfsync", "always", "--appenddirname", "aof"]),
  "--aof-use-rdb-preamble",
  "yes",
  "--aof-timestamp-enabled",
  "no",
  // No fork in wasm: a rewrite runs in a ValkeyRewriter, or inline (blocking). The shard picks when.
  "--auto-aof-rewrite-percentage",
  "0",
  // Latency tracking times each command, but the Workers clock doesn't move during one.
  "--latency-tracking",
  "no",
  // A replica follows its primary: it neither expires nor evicts keys of its own (the stream deletes them), and has
  // no memory limit to fail a streamed write on, which with replies off nobody would see. Redis lacks import-mode;
  // wasm/redis/patches/0005 adds it. "3gb" is what 0 means in a 32-bit build, without a warning at every boot.
  ...(replica ? ["--import-mode", "yes", "--maxmemory", "3gb"] : ["--maxmemory", env.VALKEY_MAXMEMORY || "64mb"]),
  "--maxmemory-policy",
  env.VALKEY_MAXMEMORY_POLICY || "noeviction",
  // Every RPC batch and router socket is a new connection. The default accepts 10 per event loop cycle, which
  // queued hundreds of RPC batches until callers gave up (seen at 96 x 4 load).
  "--max-new-connections-per-cycle",
  "1000",
];
