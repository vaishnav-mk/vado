// Redis (AGPLv3) is bundled only with VADO_REDIS=1; otherwise vite.config.ts points its import at a null module.
import valkey from "@vado/wasm/valkey.wasm";
import redis from "@vado/wasm/redis.wasm";
import type { Flavour } from "../catalog/types";

// SAFETY: the alias in vite.config.ts makes the redis import null in a build without Redis.
const redisBuild = redis as WebAssembly.Module | null;

export const WASM: Partial<Record<Flavour, WebAssembly.Module>> = redisBuild
  ? { valkey, redis: redisBuild }
  : { valkey };

const WASM_FLAVOURS: Flavour[] = redisBuild ? ["valkey", "redis"] : ["valkey"];

// redis-native needs the build's container application (VADO_CONTAINERS=1), which sets BOX.
export const flavoursOf = (box: string | undefined): Flavour[] =>
  box === "1" ? [...WASM_FLAVOURS, "redis-native"] : WASM_FLAVOURS;

export const flavourOf = (name: string): Flavour => (name.split(".").includes("redis") ? "redis" : "valkey");

export function serverOf(name: string): WebAssembly.Module {
  const module = WASM[flavourOf(name)];

  if (!module) throw new Error(`this build doesn't run ${flavourOf(name)}`);

  return module;
}
