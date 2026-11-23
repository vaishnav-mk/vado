import { replicaBinding, replicaName, SHARD_BINDINGS } from "../replication/names";
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

// The "redis" segment tells each object what to boot (flavourOf); database names have no dots, so none looks like it.
export const shardName = (db: Pick<DatabaseRecord, "name" | "created" | "flavour">, i: ShardIndex): string =>
  `${db.name}.${db.created.toString(36)}${db.flavour === "redis" ? ".redis" : ""}.${i}`;

// Shards less than db.classes apart never share an isolate; databases from before classes, and pub/sub, use class 0.
const classOf = (db: Placed, i: ShardIndex): number =>
  i !== "pubsub" && db.classes !== null && db.classes > 1 ? i % db.classes : 0;

const shardObject = (
  env: Env,
  binding: ShardBinding,
  name: string,
  options: DurableObjectNamespaceGetDurableObjectOptions,
): DurableObjectStub<ValkeyShard> => env[binding].getByName(name, options);

export const shardStub = (env: Env, db: Placed, i: ShardIndex) =>
  shardObject(
    env,
    SHARD_BINDINGS[classOf(db, i)],
    shardName(db, i),
    objectOptions(env, i !== "pubsub" && db.regions ? db.regions[i % db.regions.length] : env.LOCATION_HINT),
  );

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
