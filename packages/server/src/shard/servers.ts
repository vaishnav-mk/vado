// Redis (AGPLv3) is bundled only with VADO_REDIS=1; otherwise vite.config.ts points its import at a null module.
import valkey from "@vado/wasm/valkey.wasm";
import redis from "@vado/wasm/redis.wasm";
import type { Flavour } from "../catalog/types";

// SAFETY: the alias in vite.config.ts makes the redis import null in a build without Redis.
const redisBuild = redis as WebAssembly.Module | null;

export const WASM: Partial<Record<Flavour, WebAssembly.Module>> = redisBuild
  ? { valkey, redis: redisBuild }
  : { valkey };

export const FLAVOURS: Flavour[] = redisBuild ? ["valkey", "redis"] : ["valkey"];

/** What an object runs, from its name: a Redis database's objects have a "redis" segment (shardName). */
export const flavourOf = (name: string): Flavour => (name.split(".").includes("redis") ? "redis" : "valkey");

/** The server an object named `name` boots. */
export function serverOf(name: string): WebAssembly.Module {
  const module = WASM[flavourOf(name)];

  if (!module) throw new Error(`this build doesn't run ${flavourOf(name)}`);

  return module;
}
