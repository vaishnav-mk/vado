import { VERSIONS } from "@vado/server/catalog/flavours.ts";
import type { Server } from "@vado/server/catalog/types.ts";

// Measured on production, one account. Cold starts: TCP from one client to shards in one region.
// Pipeline: 20,000 mixed commands over Spectrum TCP from one laptop.

export type { Server };

export interface ServerFacts {
  name: string;
  version: string;
  info: string;
  wasm: string;
  licence: string;
  firstSet: string;
  nextSet: string;
  firstGet16: string;
  firstGet56: string;
}

export const SERVERS: Record<Server, ServerFacts> = {
  valkey: {
    name: "Valkey",
    version: VERSIONS.valkey,
    info: `valkey_version:${VERSIONS.valkey}`,
    wasm: "1.94 MB (0.75 MB gzipped)",
    licence: "BSD-3-Clause",
    firstSet: "547-812 ms",
    nextSet: "51-66 ms",
    firstGet16: "203-315 ms",
    firstGet56: "296-398 ms",
  },
  redis: {
    name: "Redis",
    version: VERSIONS.redis,
    info: `redis_version:${VERSIONS.redis}`,
    wasm: "2.38 MB (0.93 MB gzipped)",
    licence: "AGPL-3.0",
    firstSet: "574-659 ms",
    nextSet: "51-75 ms",
    firstGet16: "263-336 ms",
    firstGet56: "274-305 ms",
  },
};
