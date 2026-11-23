// Measured on production, one account. Cold starts: TCP from one client to shards in one region.
// Pipeline: 20,000 mixed commands over Spectrum TCP from one laptop.

export type Server = "valkey" | "redis";

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
  pipeline: string;
}

export const SERVERS: Record<Server, ServerFacts> = {
  valkey: {
    name: "Valkey",
    version: "9.1.1",
    info: "valkey_version:9.1.1",
    wasm: "1.94 MB (0.75 MB gzipped)",
    licence: "BSD-3-Clause",
    firstSet: "486-648 ms",
    nextSet: "49-62 ms",
    firstGet16: "75-395 ms",
    firstGet56: "79-353 ms",
    pipeline: "22.9k-27.2k ops/s",
  },
  redis: {
    name: "Redis",
    version: "8.12.0",
    info: "redis_version:8.12.0",
    wasm: "2.38 MB (0.93 MB gzipped)",
    licence: "AGPL-3.0",
    firstSet: "512-642 ms",
    nextSet: "50-66 ms",
    firstGet16: "161-293 ms",
    firstGet56: "146-316 ms",
    pipeline: "28.0k-29.0k ops/s",
  },
};
