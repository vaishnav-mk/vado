// redis-native: the unmodified server in a container (box/); the others are wasm in the shard object.
export type Flavour = "valkey" | "redis" | "redis-native";

export type Hint = "wnam" | "enam" | "sam" | "weur" | "eeur" | "apac" | "apac-ne" | "apac-se" | "oc" | "afr" | "me";

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

export interface Epoch {
  from: number;
  shards: number;
}

export type ShardIndex = number | "pubsub";
