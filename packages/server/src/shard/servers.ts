// Redis (AGPLv3) is bundled only with VADO_REDIS=1; otherwise vite.config.ts points its import at a null module.
import valkey from "@vado/wasm/valkey.wasm";
import redis from "@vado/wasm/redis.wasm";
import { flavourOf, serverOf } from "../catalog/flavours";
import type { Flavour, Server } from "../catalog/types";

// SAFETY: the alias in vite.config.ts makes the redis import null in a build without Redis.
const redisBuild = redis as WebAssembly.Module | null;

const WASM: Partial<Record<Server, WebAssembly.Module>> = redisBuild ? { valkey, redis: redisBuild } : { valkey };

const WASM_SERVERS: Server[] = redisBuild ? ["valkey", "redis"] : ["valkey"];

// Each wasm server, then its native one when the build's container application (VADO_CONTAINERS=1) has an image for
// it, as BOX lists. A native server needs its wasm build too: that answers COMMAND for the routers.
export const flavoursOf = (box: string | undefined): Flavour[] => {
  const images = box?.split(",") ?? [];

  return WASM_SERVERS.flatMap((s): Flavour[] => (images.includes(s) ? [s, `${s}-native`] : [s]));
};

export function wasmOf(name: string): WebAssembly.Module {
  const server = serverOf(flavourOf(name));
  const module = WASM[server];

  if (!module) throw new Error(`this build doesn't run ${server}`);

  return module;
}
