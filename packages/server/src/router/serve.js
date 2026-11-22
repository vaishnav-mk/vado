// One client connection (TCP, WebSocket or service binding) -> one Router on its database, until it
// closes. Also what this isolate reports to the Pulse object: its colo and open connections.
import { Router, setSocketBudget } from "./router.js";
import { commandTable } from "../protocol/commands.js";
import {
  database,
  forget,
  lookup,
  objectOptions,
  replicaRegion,
  replicaStub,
  shardStub,
} from "../catalog/databases.js";
import { coloOf } from "../replication/regions.js";
import { deployedAt, IDLE_MS, PULSE_MS } from "../constants.js";

const tables = new Map(); // flavour -> Promise<command table>, per isolate

export function commands(env, flavour = "valkey") {
  // Any Valkey (or Redis) answers COMMAND the same way; a dedicated object keeps it off data shards. Cached
  // as a promise: hundreds of connections landing on a cold isolate would otherwise all ask at once.
  let table = tables.get(flavour);

  if (!table) {
    table = env.SHARD.getByName(flavour === "valkey" ? "__meta" : `__meta.${flavour}`, objectOptions(env))
      .run([["COMMAND"]])
      .then((r) => commandTable(r[0]));
    table.catch(() => tables.delete(flavour));
    tables.set(flavour, table);
  }

  return table;
}

// Failed AUTHs per client address, counted in each Cloudflare location by the AUTH_LIMIT rate limiting binding.
// Past its limit an address may not AUTH for a minute, so nobody can guess passwords, or database names (each
// unknown name asks the catalog), at speed. The block is also kept per isolate, so a blocked client costs nothing.
const blockedUntil = new Map(); // client IP -> ms
const BLOCK_MS = 60_000;

const ipOf = (addr) =>
  !addr
    ? null
    : addr.startsWith("[")
      ? addr.slice(1, addr.indexOf("]"))
      : /^[\d.]+:\d+$/.test(addr)
        ? addr.slice(0, addr.lastIndexOf(":"))
        : addr;

function signIns(env, where) {
  const ip = ipOf(where?.addr);

  if (!env.AUTH_LIMIT || !ip) return null;

  return {
    blocked: () => (blockedUntil.get(ip) ?? 0) > Date.now(),
    failed: () =>
      env.AUTH_LIMIT.limit({ key: ip }).then(
        ({ success }) => {
          if (success) return;
          const now = Date.now();

          if (blockedUntil.size > 10_000) for (const [k, t] of blockedUntil) if (t <= now) blockedUntil.delete(k);
          blockedUntil.set(ip, now + BLOCK_MS);
        },
        () => {},
      ),
  };
}

const handles = (env, db) => ({
  db,
  shard: (i) => shardStub(env, db, i),
  pubsub: () => shardStub(env, db, "pubsub"),
  replica: (i) => {
    const r = replicaRegion(db, live.colo);

    return r && replicaStub(env, db, i, r);
  },
});

// Isolate-wide, so one report covers every connection here. Each connection flushes from its own
// timer, so no request does I/O on behalf of another.
// `done` counts the commands of connections that have closed, per database, so short connections still count.
export const live = { isolate: null, colo: null, coloTried: 0, conns: new Map(), flushed: 0, done: {} };

function learnColo() {
  const now = Date.now();

  if (live.colo || now - live.coloTried < 10_000) return;
  live.coloTried = now;
  coloOf().then(
    (c) => {
      live.colo ??= c;
    },
    () => {},
  );
}

function report(env, minGap = PULSE_MS) {
  const now = Date.now();

  if (!env.PULSE || now - live.flushed < minGap) return;
  live.flushed = now;

  const conns = [...live.conns.values()].map(({ router, ...c }) => ({
    ...c,
    db: router?.db.name ?? c.db,
    commands: router?.commands ?? 0,
  }));

  env.PULSE.getByName("pulse")
    .report({ isolate: live.isolate, colo: live.colo, conns, done: live.done })
    .catch(() => {});
}

/** Serves one connection on database `name`. `via` is how it arrived ("tcp", "ws" or "binding"); `where` is
 *  what's known of the client's location. */
export async function serve(socket, env, name, via = "tcp", where = null) {
  live.isolate ??= crypto.randomUUID();
  learnColo();
  const conn = { id: crypto.randomUUID(), db: name, via, where, since: Date.now(), router: null };
  live.conns.set(conn.id, conn);
  const tick = env.PULSE ? setInterval(() => report(env), PULSE_MS) : null;

  try {
    await serveRouter(socket, env, name, conn);
  } finally {
    clearInterval(tick);
    live.conns.delete(conn.id);
    const d = conn.router?.db.name ?? conn.db;
    live.done[d] = (live.done[d] ?? 0) + (conn.router?.commands ?? 0);
    report(env, 250);
  }
}

/** A connection to database `name` served by a Router in this isolate, as a service binding's would be (our own
 *  code: the shared password opens any database). */
export function connectLocal(env, name) {
  const up = new TransformStream(),
    down = new TransformStream();

  void serve({ readable: up.readable, writable: down.writable }, env, name, "binding");

  return { readable: down.readable, writable: up.writable };
}

async function serveRouter(socket, env, name, conn) {
  let db, t;

  try {
    [db, t] = await Promise.all([database(env, name), commands(env)]);

    if (db.flavour !== "valkey") t = await commands(env, db.flavour);
  } catch (e) {
    const w = socket.writable.getWriter();
    await w.write(new TextEncoder().encode(`-ERR ${e.message}\r\n`)).catch(() => {});
    await w.close().catch(() => {});

    return;
  }

  if (env.ROUTER_SOCKET_BUDGET) setSocketBudget(Number(env.ROUTER_SOCKET_BUDGET));

  const router = new Router(socket, {
    ...handles(env, db),
    table: t,
    password: env.VALKEY_PASSWORD,
    trusted: conn.via === "binding", // our own Workers: the shared password opens any database
    lookup: (n) => lookup(env, n),
    open: async (n) => {
      const next = await database(env, n);

      return { ...handles(env, next), table: await commands(env, next.flavour) };
    },
    onDropped: forget,
    signIns: conn.via === "binding" ? null : signIns(env, conn.where),
    idleMs: Number(env.ROUTER_IDLE_MS || IDLE_MS),
    dial: `router-${deployedAt(env)}:6379`,
  });

  conn.router = router;
  report(env);
  await router.run();
}
