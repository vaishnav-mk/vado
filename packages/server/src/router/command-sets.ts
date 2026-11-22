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

/** What a connection may send while it is a RESP2 pub/sub pipe, besides PUBSUB. */
export const WHILE_SUBSCRIBED = new Set(["ping", "quit", "reset"]);

export const BEFORE_AUTH = new Set(["auth", "hello", "quit"]);

/** What runs at once inside MULTI instead of being queued. */
export const TX_CONTROL = new Set(["exec", "discard", "multi", "watch", "quit", "reset"]);

// save/bgrewriteaof: shards schedule their own AOF rewrites. acl: the router does AUTH; a shard password would
// lock the routers out.
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

// CONFIG SET reaches every shard, so it may change how data behaves, never durability, memory, networking or
// auth: those belong to the service, and a shard shares its isolate's memory.
export const CONFIG_SET = new Set([
  "maxmemory-policy",
  "maxmemory-samples",
  "notify-keyspace-events",
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
  "slowlog-log-slower-than",
  "slowlog-max-len",
  "latency-monitor-threshold",
  "busy-reply-threshold",
  "lua-time-limit",
  "activerehashing",
]);

// Commands the router answers itself: queued in MULTI they would reach one shard's connection, which may be a
// pooled one other clients share.
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

/** Subcommands sent to every shard, so EVALSHA and FCALL work wherever their keys land. */
export const SCRIPT_EVERYWHERE = new Set(["load", "flush"]);
export const FUNCTION_EVERYWHERE = new Set(["load", "delete", "flush", "restore"]);
