import type { DurabilityScheduler } from "durability";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { replicaNamespace } from "../catalog/placement";
import { isReplicaName } from "./replication/names";
import { WasmHost } from "./host/wasm-host";
import { migrate } from "../migrate";
import { replicationMigrations } from "./replication/migrations";
import { shardMigrations } from "./migrations";
import { PrimaryRole } from "./primary";
import { ReplicaRole } from "./replica";
import { resetSoon } from "./reset";
import type { LiveShard, RewriterStub } from "./types";
import { flavourOf } from "../catalog/flavours";
import { wasmOf } from "../shard/servers";
import { Upgrader } from "./upgrade";
import { reapply, settingsMigrations } from "../settings";
import { valkeyArgs } from "./valkey-args";
import { deployedAt } from "../shard/version";

const REWRITERS = [
  "REWRITER",
  "REWRITER1",
  "REWRITER2",
  "REWRITER3",
  "REWRITER4",
  "REWRITER5",
  "REWRITER6",
  "REWRITER7",
] as const satisfies (keyof Env)[];

// Placement keeps primaries in classes 0-7.
function rewriterOf(env: Env, shardClass: number, name: string): RewriterStub {
  if (shardClass >= REWRITERS.length) throw new Error(`no rewriter for shard class ${shardClass}`);
  const namespace = env[REWRITERS[shardClass]];

  // A fresh stub each time: one that saw its object reset stays broken.
  return () => namespace.getByName(name);
}

export function bootShard(
  ctx: DurableObjectState,
  env: Env,
  db: DrizzleSqliteDODatabase,
  scheduler: DurabilityScheduler,
  shardClass: number,
): LiveShard {
  const name = ctx.id.name ?? "";
  const replica = isReplicaName(name);
  const flavour = flavourOf(name);

  migrate(ctx.storage, [...shardMigrations, ...replicationMigrations, ...settingsMigrations]);

  const host = new WasmHost(wasmOf(name), ctx.storage, {
    args: valkeyArgs(env, replica),
    sync: () => ctx.storage.sync(),
    fatal: (e: Error) => void resetSoon(ctx, e.message),
  });

  if (replica) {
    const upgrader = new Upgrader(ctx, env, db, host, null);

    return {
      host,
      flavour,
      upgrader,
      primary: null,
      replica: new ReplicaRole(ctx, host, (t) => upgrader.restartFor(t)),
    };
  }

  void reapply(ctx.storage.sql, (bytes) => host.execBatch(bytes, 1)); // ahead of any client command
  const rewriter = rewriterOf(env, shardClass, name);
  const replicas = replicaNamespace(env, shardClass);
  const deployed = deployedAt(env);
  const retryAt = (at: number): Promise<void> => primary.alarms.upgrade(at);
  const primary: PrimaryRole = new PrimaryRole(ctx, host, scheduler, replicas, deployed, rewriter, () => upgrader);
  const upgrader: Upgrader = new Upgrader(ctx, env, db, host, { rewriter, retryAt });
  host.onInput = () => upgrader.checkVersion();

  return { host, flavour, upgrader, primary, replica: null };
}
