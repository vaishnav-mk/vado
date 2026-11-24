import type { Flavour, Server } from "./types";

export const FLAVOURS = ["valkey", "valkey-native", "redis", "redis-native"] as const satisfies readonly Flavour[];

export const FLAVOUR_NAMES: Record<Flavour, string> = {
  valkey: "Valkey",
  "valkey-native": "Valkey in containers",
  redis: "Redis",
  "redis-native": "Redis in containers",
};

// The pinned releases; packages/wasm/update.sh moves them with the builds.
export const VERSIONS: Record<Server, string> = {
  valkey: "9.1.1",
  redis: "8.12.0",
};

export const isFlavour = (s: string | null): s is Flavour => FLAVOURS.some((f) => f === s);

export const isNative = (f: Flavour): boolean => f.endsWith("-native");

export const serverOf = (f: Flavour): Server => (f.startsWith("redis") ? "redis" : "valkey");

// The first segment is the database's name, which may be "redis"; Valkey has no segment (shardName).
export const flavourOf = (name: string): Flavour => name.split(".").slice(1).find(isFlavour) ?? "valkey";
