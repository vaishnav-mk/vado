import type { HINT_LIST } from "./regions";

export type Server = "valkey" | "redis";

// A server compiled to wasm inside each shard's object, or "-native": unmodified in a container beside it.
export type Flavour = Server | `${Server}-native`;

export type Hint = (typeof HINT_LIST)[number];

export interface DatabaseRecord {
  name: string;
  created: number;
  shards: number;
  regions: Hint[] | null;
  replicas: Hint[] | null;
  classes: number | null;
  // "salt:sha256(salt + password)" in hex; null: VALKEY_PASSWORD.
  secret: string | null;
  dropped?: number | null;
  flavour: Flavour;
}

export type DatabaseSummary = Omit<DatabaseRecord, "secret" | "dropped"> & { password: number };

export interface Epoch {
  from: number;
  shards: number;
}

export type ShardIndex = number | "pubsub";
