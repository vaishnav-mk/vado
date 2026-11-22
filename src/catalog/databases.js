// A database's record (from the catalog, cached per isolate) and the Durable Objects that hold it: its
// shards, their read replicas, and the per-shard naming and placement rules.
import { HINTS, REGION_OF } from "../replication/regions.js";
import { replicaBinding, replicaName } from "../replication/replication.js";

// Per isolate, cache the promise, not the result: hundreds of connections landing on a cold isolate
// would otherwise all ask the catalog at once. A failed lookup is dropped so the next connection retries.
const dbs = new Map(); // name -> Promise<db>; a database's record never changes once created

export const objectOptions = (env, hint = env.LOCATION_HINT) => (HINTS.has(hint) ? { locationHint: hint } : {});
const shardName = (db, i) => `${db.name}.${db.created.toString(36)}.${i}`;
// Shard i uses class k = i % db.classes, so shards less than db.classes apart never share an isolate.
// Databases from before classes have none: all their shards are ValkeyShard (k = 0). Pub/sub stays there too.
const classOf = (db, i) => (typeof i === "number" && db.classes > 1 ? i % db.classes : 0);
const shardNs = (env, db, i) => (classOf(db, i) ? env[`SHARD${classOf(db, i)}`] : env.SHARD);
// A spread database places data shard i in regions[i % n]; its pub/sub shard stays at LOCATION_HINT.
export const shardStub = (env, db, i) =>
  shardNs(env, db, i).getByName(shardName(db, i), objectOptions(env, typeof i === "number" && db.regions ? db.regions[i % db.regions.length] : env.LOCATION_HINT));
// Its read replicas use class 8 + k (replicaBinding), so a replica never shares an isolate with a primary.
export const replicaStub = (env, db, i, region) => env[replicaBinding(classOf(db, i))].getByName(replicaName(shardName(db, i), region), objectOptions(env, region));

// Which replica (if any) a router in `colo` reads from: one in its region, else a neighbouring one. The home
// region has a replica too: the primary's replies wait for its storage commits, a replica's don't.
const NEAR = { wnam: ["enam"], enam: ["wnam"], sam: ["enam", "wnam"], weur: ["eeur"], eeur: ["weur"], me: ["eeur", "weur"], afr: ["weur", "eeur"], apac: ["oc"], oc: ["apac"] };
export function replicaRegion(db, colo) {
  const mine = db.replicas && REGION_OF.get(colo);
  if (!mine) return null;
  for (const r of [mine, ...NEAR[mine]]) if (db.replicas.includes(r)) return r;
  return null;
}

/** Tell every primary shard of a replicated database where to keep its replicas (idempotent). */
export const configureReplicas = (env, db) =>
  Promise.all(Array.from({ length: db.shards }, (_, i) => shardStub(env, db, i).replicate(db.replicas)));

/** The database's record, created with these settings if it doesn't exist yet. */
export function database(env, name, shards, regions, replicas, classes, secret) {
  let db = dbs.get(name);
  if (!db) {
    db = env.CATALOG.getByName("catalog").get(name, shards, regions, replicas, classes, secret);
    db.catch(() => dbs.delete(name));
    dbs.set(name, db);
  }
  return db;
}

/** Forgets this isolate's copy of a database's record (it was dropped). */
export const forget = (name) => dbs.delete(name);

/** The catalog's record of a database, dropped or not (null if none), never cached: for the dashboard, which must
 *  see a drop that this isolate's cache doesn't. */
export const current = (env, name) => env.CATALOG.getByName("catalog").find(name);

/** The database's record if it exists (null if not): unlike database(), never creates one. */
export async function lookup(env, name) {
  const cached = dbs.get(name);
  return cached ? await cached : await current(env, name);
}
