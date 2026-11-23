// One client connection (TCP, WebSocket or service binding) -> one Router on its database, until it closes.
import { database, forget, lookup } from "../catalog/databases";
import { replicaRegion, replicaStub, shardStub } from "../catalog/placement";
import type { DatabaseRecord } from "../catalog/types";
import type { CommandTable } from "../protocol/types";
import { deployedAt } from "../shard/version";
import { commands } from "./command-table";
import { IDLE_MS, PULSE_MS } from "./config";
import { setSocketBudget } from "./isolate";
import { learnColo, live, report } from "./pulse-report";
import type { LiveConn } from "./pulse-report";
import { Router } from "./router";
import { signIns } from "./sign-ins";
import type { ClientSocket, DatabaseHandles, Via, Where } from "./types";
import { encoder, messageOf, noop } from "../shared";

export { live } from "./pulse-report";

const handles = (env: Env, db: DatabaseRecord, table: CommandTable): DatabaseHandles => ({
  db,
  table,
  shard: (i) => shardStub(env, db, i),
  pubsub: () => shardStub(env, db, "pubsub"),
  replica: (i) => {
    const region = live.colo === null ? null : replicaRegion(db, live.colo);

    return region ? replicaStub(env, db, i, region) : null;
  },
});

async function open(env: Env, name: string): Promise<DatabaseHandles> {
  const db = await database(env, name);

  return handles(env, db, await commands(env, db.flavour));
}

/** Serves one connection on database `name`. `via` is how it arrived; `where` what's known of the client's location. */
export async function serve(
  socket: ClientSocket,
  env: Env,
  name: string,
  via: Via = "tcp",
  where: Where | null = null,
): Promise<void> {
  learnColo();
  const conn: LiveConn = { id: crypto.randomUUID(), db: name, via, where, since: Date.now(), router: null };
  live.conns.set(conn.id, conn);
  const tick = setInterval(() => report(env), PULSE_MS);

  try {
    await serveRouter(socket, env, name, conn);
  } finally {
    clearInterval(tick);
    live.conns.delete(conn.id);
    const db = conn.router?.db.name ?? conn.db;
    live.done[db] = (live.done[db] ?? 0) + (conn.router?.commands ?? 0);
    report(env, 250);
  }
}

async function serveRouter(socket: ClientSocket, env: Env, name: string, conn: LiveConn): Promise<void> {
  let target: DatabaseHandles;

  try {
    // The Valkey table is asked for alongside the record: most databases need it.
    const [db, valkey] = await Promise.all([database(env, name), commands(env)]);
    target = handles(env, db, db.flavour === "valkey" ? valkey : await commands(env, db.flavour));
  } catch (cause) {
    const w = socket.writable.getWriter();
    await w.write(encoder.encode(`-ERR ${messageOf(cause)}\r\n`)).catch(noop);
    await w.close().catch(noop);
    // Nothing reads the client's commands now; cancelling fails their writes instead of leaving them waiting.
    await socket.readable.cancel().catch(noop);

    return;
  }

  if (env.ROUTER_SOCKET_BUDGET) setSocketBudget(Number(env.ROUTER_SOCKET_BUDGET));
  const binding = conn.via === "binding";

  const router = new Router(socket, target, {
    password: env.VALKEY_PASSWORD || undefined,
    trusted: binding,
    lookup: (n) => lookup(env, n),
    open: (n) => open(env, n),
    onDropped: forget,
    signIns: binding ? null : signIns(env, conn.where),
    idleMs: Number(env.ROUTER_IDLE_MS || IDLE_MS),
    dial: `router-${deployedAt(env)}:6379`,
  });

  conn.router = router;
  report(env);
  await router.run();
}
