import type { Flavour, Server } from "./types";

export const FLAVOURS = ["valkey", "valkey-native", "redis", "redis-native"] as const satisfies readonly Flavour[];

export const FLAVOUR_NAMES: Record<Flavour, string> = {
  valkey: "Valkey",
  "valkey-native": "Valkey in containers",
  redis: "Redis",
  "redis-native": "Redis in containers",
};

export const isFlavour = (s: string | null): s is Flavour => FLAVOURS.some((f) => f === s);

export const isNative = (f: Flavour): boolean => f.endsWith("-native");

export const serverOf = (f: Flavour): Server => (f.startsWith("redis") ? "redis" : "valkey");

// Every object's name carries its database's flavour after the database's own name, which may be "redis" (Valkey's
// flavour is no segment at all; placement.ts).
export const flavourOf = (name: string): Flavour => name.split(".").slice(1).find(isFlavour) ?? "valkey";
