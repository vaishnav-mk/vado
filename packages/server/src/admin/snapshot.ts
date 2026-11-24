import { replicaStub, shardStub } from "../catalog/placement";
import type { DatabaseRecord } from "../catalog/types";
import type { ShardSnapshot } from "../shard/types";
import type { Down, ShardLook } from "./types";

const look = (stub: ReturnType<typeof shardStub>): Promise<ShardSnapshot | Down> =>
  stub.snapshot().catch((e: Error) => ({ down: e.message }));

export const shardSnapshots = (env: Env, db: DatabaseRecord): Promise<ShardLook[]> =>
  Promise.all(
    Array.from({ length: db.shards }, async (_, i): Promise<ShardLook> => {
      const primary = await look(shardStub(env, db, i));

      if ("down" in primary) return { ...primary, replicaSnapshots: [] };
      // Only ready replicas are asked, so a sleeping database's retired replicas aren't woken to be looked at.
      const ready = primary.replicas.flatMap((r) => (r.state === "ready" ? [r.region] : []));
      const copies = await Promise.all(ready.map((region) => look(replicaStub(env, db, i, region))));

      return { ...primary, replicaSnapshots: copies.map((c, k) => ({ region: ready[k], ...c })) };
    }),
  );
