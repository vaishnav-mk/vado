export const SUBSCRIBE = new Set(["subscribe", "psubscribe", "ssubscribe"]);

export const PUBSUB = new Set([
  "publish",
  "spublish",
  "pubsub",
  "unsubscribe",
  "punsubscribe",
  "sunsubscribe",
  ...SUBSCRIBE,
]);

export const WHILE_SUBSCRIBED = new Set(["ping", "quit", "reset"]);

export const BEFORE_AUTH = new Set(["auth", "hello", "quit"]);

export const TX_CONTROL = new Set(["exec", "discard", "multi", "watch", "quit", "reset"]);

// Shards schedule their own AOF rewrites; the router does AUTH, and a shard password would lock routers out.
export const UNSUPPORTED = new Set([
  "monitor",
  "sync",
  "psync",
  "replicaof",
  "slaveof",
  "failover",
  "shutdown",
  "debug",
  "migrate",
  "move",
  "swapdb",
  "bgsave",
  "save",
  "bgrewriteaof",
  "acl",
]);

// How data behaves only: durability, memory, networking and auth belong to the service, and shards share memory.
// No keyspace events (SUBSCRIBE goes to the pub/sub shard) or time limits (the clock stands still during a pass).
export const CONFIG_SET = new Set([
  "maxmemory-policy",
  "maxmemory-samples",
  "hash-max-listpack-entries",
  "hash-max-listpack-value",
  "hash-max-ziplist-entries",
  "hash-max-ziplist-value",
  "list-max-listpack-size",
  "list-max-ziplist-size",
  "list-compress-depth",
  "set-max-intset-entries",
  "set-max-listpack-entries",
  "set-max-listpack-value",
  "zset-max-listpack-entries",
  "zset-max-listpack-value",
  "zset-max-ziplist-entries",
  "zset-max-ziplist-value",
  "hll-sparse-max-bytes",
  "stream-node-max-bytes",
  "stream-node-max-entries",
  "lfu-log-factor",
  "lfu-decay-time",
  "slowlog-max-len",
  "activerehashing",
]);

// Answered by the router: queued in MULTI they would reach one shard's connection, which may be a pooled one.
export const NOT_IN_MULTI = new Set([
  "select",
  "client",
  "hello",
  "auth",
  "readonly",
  "readwrite",
  "flushall",
  "flushdb",
  "dbsize",
  "keys",
  "scan",
  "randomkey",
  "info",
  "script",
  "function",
  "config",
  "wait",
  "waitaof",
  "cluster",
]);

export const CLIENT_UNSUPPORTED = new Set([
  "tracking",
  "caching",
  "getredir",
  "trackinginfo",
  "kill",
  "pause",
  "unpause",
  "unblock",
  "reply",
  "list",
  "no-evict",
  "no-touch",
  "capa",
  "import-source",
]);

// Sent to every shard, so EVALSHA and FCALL work wherever their keys land.
export const SCRIPT_EVERYWHERE = new Set(["load", "flush"]);
export const FUNCTION_EVERYWHERE = new Set(["load", "delete", "flush", "restore"]);
