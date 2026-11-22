/** Which server a database runs; fixed when it is created. */
export type Flavour = "valkey" | "redis";

/** A Durable Object location hint. */
export type Hint = "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac" | "apac-ne" | "apac-se" | "oc" | "afr" | "me";

/** A database's catalog record. Everything but `dropped` is fixed when it is created. */
export interface DatabaseRecord {
  name: string;
  /** ms; part of every shard's name, so it never changes. */
  created: number;
  shards: number;
  /** Where its shards are placed (shard i in regions[i % n]); null: LOCATION_HINT. */
  regions: Hint[] | null;
  /** Regions that keep a read replica of every shard; null: none. */
  replicas: Hint[] | null;
  /** How many shard classes its shards rotate over; null: 1. */
  classes: number | null;
  /** Its own password, as "salt:sha256(salt + password)" in hex; null: VALKEY_PASSWORD. */
  secret: string | null;
  /** When it was dropped; absent on a record just created. */
  dropped?: number | null;
  flavour: Flavour;
}

/** A database as Catalog.list() gives it: no password hash, only whether it has one (0 or 1). */
export interface DatabaseSummary {
  name: string;
  created: number;
  shards: number;
  regions: Hint[] | null;
  replicas: Hint[] | null;
  classes: number | null;
  flavour: Flavour;
  password: number;
}

/** From `from` (ms) on, new databases get `shards` shards. */
export interface Epoch {
  from: number;
  shards: number;
}

/** A data shard's index, or its pub/sub shard. */
export type ShardIndex = number | "pubsub";
