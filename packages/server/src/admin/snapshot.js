// One look at every shard of a database and at its ready replicas: Valkey's INFO plus each object's own
// stats. Only replicas the primary reports ready are asked, so a sleeping database's retired replicas
// aren't woken (and booted) just to be looked at.
import { replicaStub, shardStub } from "../catalog/databases.js";

const one = (stub) => stub.snapshot().catch((e) => ({ down: e.message }));

/** Each primary's snapshot() (or { down }), with `replicaSnapshots` from its ready replicas. */
export const shardSnapshots = (env, db) =>
  Promise.all(
    Array.from({ length: db.shards }, async (_, i) => {
      const primary = await one(shardStub(env, db, i));
      const ready = (primary.replicas ?? []).filter((r) => r.state === "ready").map((r) => r.region);
      const copies = await Promise.all(ready.map((r) => one(replicaStub(env, db, i, r))));

      return { ...primary, replicaSnapshots: copies.map((c, k) => ({ region: ready[k], ...c })) };
    }),
  );
