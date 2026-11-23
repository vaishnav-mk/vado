import type { DurabilityScheduler } from "durability";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { Flavour } from "../catalog/types";
import { isReplicaName } from "../replication/names";
import type { ReplicaNamespace } from "../replication/types";
import { ValkeyHost } from "./host/valkey-host";
import { migrate } from "../migrate";
import { replicationMigrations } from "../replication/migrations";
import { shardMigrations } from "./migrations";
import { PrimaryRole } from "./primary";
import { ReplicaRole } from "./replica";
import { resetSoon } from "./reset";
import type { ValkeyRewriter } from "./rewriter/rewriter";
import { flavourOf, serverOf } from "./servers";
import { Upgrader } from "./upgrade";
import { valkeyArgs } from "./valkey-args";
import { deployedAt } from "./version";

export interface LiveShard {
  host: ValkeyHost;
  flavour: Flavour;
  upgrader: Upgrader;
  primary: PrimaryRole | null;
  replica: ReplicaRole | null;
}

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

function rewriterOf(env: Env, shardClass: number, name: string): (() => DurableObjectStub<ValkeyRewriter>) | null {
  if (shardClass >= REWRITERS.length) return null;
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
  replicas: ReplicaNamespace,
): LiveShard {
  const name = ctx.id.name ?? "";
  const replica = isReplicaName(name);
  const flavour = flavourOf(name);

  migrate(ctx.storage, [...shardMigrations, ...replicationMigrations]);

  const host = new ValkeyHost(serverOf(name), ctx.storage, {
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

  const rewriter = rewriterOf(env, shardClass, name);
  const deployed = deployedAt(env);
  const retryAt = (at: number): Promise<void> => primary.alarms.upgrade(at);
  const primary: PrimaryRole = new PrimaryRole(ctx, host, scheduler, replicas, deployed, rewriter, () => upgrader);
  const upgrader: Upgrader = new Upgrader(ctx, env, db, host, { rewriter, retryAt });
  host.onInput = () => upgrader.checkVersion();

  return { host, flavour, upgrader, primary, replica: null };
}
