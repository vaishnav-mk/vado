// The servers a database can run. Both wasm builds have the same interface, so the host runs either.
import valkey from "@vado/wasm/valkey.wasm";
import redis from "@vado/wasm/redis.wasm";

export const WASM = { valkey, redis };
export const FLAVOURS = Object.keys(WASM);

/** What an object runs, from its name: a Redis database's objects have a "redis" segment (catalog/databases.js). */
export const flavourOf = (name) => (name.split(".").includes("redis") ? "redis" : "valkey");
