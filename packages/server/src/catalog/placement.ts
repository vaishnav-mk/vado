import { replicaBinding, replicaName, SHARD_BINDINGS } from "../replication/names";
import { isNative } from "./flavours";
import type { ShardBinding } from "../replication/names";
import { isHint, REGION_OF } from "../replication/regions";
import type { ReplicaNamespace } from "../replication/types";
import type { ValkeyShard } from "../shard/shard";
import type { DatabaseRecord, Hint, ShardIndex } from "./types";

type Placed = Pick<DatabaseRecord, "name" | "created" | "flavour" | "classes" | "regions">;

export const objectOptions = (
  env: Pick<Env, "LOCATION_HINT">,
  hint = env.LOCATION_HINT,
): DurableObjectNamespaceGetDurableObjectOptions => (hint !== undefined && isHint(hint) ? { locationHint: hint } : {});

// The flavour segment tells each object what to boot (flavourOf); database names have no dots, so none looks like it.
export const shardName = (db: Pick<DatabaseRecord, "name" | "created" | "flavour">, i: ShardIndex): string =>
  `${db.name}.${db.created.toString(36)}${db.flavour === "valkey" ? "" : `.${db.flavour}`}.${i}`;

// Shards less than db.classes apart never share an isolate; databases from before classes, and pub/sub, use class 0.
const classOf = (db: Placed, i: ShardIndex): number =>
  i !== "pubsub" && db.classes !== null && db.classes > 1 ? i % db.classes : 0;

const shardObject = (
  env: Env,
  binding: ShardBinding,
  name: string,
  options: DurableObjectNamespaceGetDurableObjectOptions,
): DurableObjectStub<ValkeyShard> => env[binding].getByName(name, options);

const boxObject = (env: Env, name: string, options: DurableObjectNamespaceGetDurableObjectOptions) =>
  // SAFETY: RedisBox (either native server) has ValkeyShard's public methods, wasm-only ones throwing, except run();
  // callers use runRaw.
  (env.REDIS_BOX as DurableObjectNamespace<ValkeyShard>).getByName(name, options);

const hintOf = (env: Env, db: Placed, i: ShardIndex) =>
  objectOptions(env, i !== "pubsub" && db.regions ? db.regions[i % db.regions.length] : env.LOCATION_HINT);

// A native database's pub/sub runs on shard 0's server: a container of its own would idle at full price.
export const shardStub = (env: Env, db: Placed, i: ShardIndex) =>
  isNative(db.flavour)
    ? boxObject(env, shardName(db, i === "pubsub" ? 0 : i), hintOf(env, db, i === "pubsub" ? 0 : i))
    : shardObject(env, SHARD_BINDINGS[classOf(db, i)], shardName(db, i), hintOf(env, db, i));

export const replicaStub = (env: Env, db: Placed, i: ShardIndex, region: Hint) =>
  shardObject(env, replicaBinding(classOf(db, i)), replicaName(shardName(db, i), region), { locationHint: region });

export const replicaNamespace = (env: Env, k: number): ReplicaNamespace => ({
  getByName: (name, options) => shardObject(env, replicaBinding(k), name, options),
});

// The home region has a replica too: the primary's replies wait for its storage commits, a replica's don't.
const NEAR: Partial<Record<Hint, Hint[]>> = {
  wnam: ["enam"],
  enam: ["wnam"],
  sam: ["enam", "wnam"],
  weur: ["eeur"],
  eeur: ["weur"],
  me: ["eeur", "weur"],
  afr: ["weur", "eeur"],
  apac: ["oc"],
  oc: ["apac"],
};

export function replicaRegion(db: Pick<DatabaseRecord, "replicas">, colo: string): Hint | null {
  const mine = db.replicas && REGION_OF.get(colo);

  if (!db.replicas || !mine) return null;

  for (const r of [mine, ...(NEAR[mine] ?? [])]) if (db.replicas.includes(r)) return r;

  return null;
}

export const configureReplicas = (env: Env, db: Placed & Pick<DatabaseRecord, "shards" | "replicas">) =>
  Promise.all(Array.from({ length: db.shards }, (_, i) => shardStub(env, db, i).replicate(db.replicas ?? [])));
