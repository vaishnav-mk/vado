import { SUBSCRIBE } from "../protocol/commands";

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
