// The Durable Objects that hold a database: its shards and their read replicas, how they are named and placed.
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

// A Redis database's objects have a "redis" segment in their names, so each one knows what to boot (flavourOf);
// database names have no dots, so no database name can look like it.
export const shardName = (db: Pick<DatabaseRecord, "name" | "created" | "flavour">, i: ShardIndex): string =>
  `${db.name}.${db.created.toString(36)}${db.flavour === "redis" ? ".redis" : ""}.${i}`;

// Shard i uses class i % db.classes, so shards less than db.classes apart never share an isolate. Databases from
// before classes have none: all their shards are class 0. Pub/sub stays there too.
const classOf = (db: Placed, i: ShardIndex): number =>
  i !== "pubsub" && db.classes !== null && db.classes > 1 ? i % db.classes : 0;

const shardObject = (
  env: Env,
  binding: ShardBinding,
  name: string,
  options: DurableObjectNamespaceGetDurableObjectOptions,
): DurableObjectStub<ValkeyShard> => env[binding].getByName(name, options);

// A spread database places data shard i in regions[i % n]; its pub/sub shard stays at LOCATION_HINT.
export const shardStub = (env: Env, db: Placed, i: ShardIndex) =>
  shardObject(
    env,
    SHARD_BINDINGS[classOf(db, i)],
    shardName(db, i),
    objectOptions(env, i !== "pubsub" && db.regions ? db.regions[i % db.regions.length] : env.LOCATION_HINT),
  );

// Its read replicas use class 8 + k (replicaBinding), so a replica never shares an isolate with a primary.
export const replicaStub = (env: Env, db: Placed, i: ShardIndex, region: Hint) =>
  shardObject(env, replicaBinding(classOf(db, i)), replicaName(shardName(db, i), region), { locationHint: region });

/** Where a primary of shard class k keeps its replicas: for its Replicator, which names them (replicaOf). */
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

/** Which replica (if any) a router in `colo` reads from: the one in its region, else a neighbouring one. */
export function replicaRegion(db: Pick<DatabaseRecord, "replicas">, colo: string): Hint | null {
  const mine = db.replicas && REGION_OF.get(colo);

  if (!db.replicas || !mine) return null;

  for (const r of [mine, ...(NEAR[mine] ?? [])]) if (db.replicas.includes(r)) return r;

  return null;
}

/** Tells every primary shard of a replicated database where to keep its replicas (idempotent). */
export const configureReplicas = (env: Env, db: Placed & Pick<DatabaseRecord, "shards" | "replicas">) =>
  Promise.all(Array.from({ length: db.shards }, (_, i) => shardStub(env, db, i).replicate(db.replicas ?? [])));
