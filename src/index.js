// Worker entry: TCP connect() -> sharding router; fetch() -> admin + bench (token-protected).
import { Router, setSocketBudget } from "./router.js";
import { commandTable } from "./commands.js";
import { bench } from "./bench.js";
import { IDLE_MS, PULSE_MS, WS_MAX_QUEUED } from "./constants.js";
import { coloOf } from "./pulse.js";
import { HINTS } from "./catalog.js";
import { REGION_OF } from "./regions.js";
import { replicaName } from "./replication.js";

export { ValkeyShard, ValkeyShard1, ValkeyShard2, ValkeyShard3, ValkeyShard4, ValkeyShard5, ValkeyShard6, ValkeyShard7 } from "./shard.js";
export { Catalog } from "./catalog.js";
export { ValkeyRewriter } from "./rewriter.js";
export { Pulse } from "./pulse.js";
export { Sender } from "./sender.js";

// Per isolate, cache the promise, not the result: hundreds of connections landing on a cold isolate
// would otherwise all fetch the COMMAND table at once (796 RPCs in a minute, and the isolate hit its
// 128 MB limit). A failed lookup is dropped so the next connection retries.
const dbs = new Map(); // name -> Promise<db>; a database's record never changes once created
let table = null; // Promise<command table>

export const objectOptions = (env, hint = env.LOCATION_HINT) => (HINTS.has(hint) ? { locationHint: hint } : {});
export const shardName = (db, i) => `${db.name}.${db.created.toString(36)}.${i}`;
// Shard i (and its replicas) uses class i % db.classes, so a database's shards never share an isolate.
// Databases from before classes have none: all their shards are ValkeyShard. Pub/sub stays there too.
const shardNs = (env, db, i) => (typeof i === "number" && db.classes > 1 && i % db.classes ? env[`SHARD${i % db.classes}`] : env.SHARD);
// A spread database places data shard i in regions[i % n]; its pub/sub shard stays at LOCATION_HINT.
export const shardStub = (env, db, i) =>
  shardNs(env, db, i).getByName(shardName(db, i), objectOptions(env, typeof i === "number" && db.regions ? db.regions[i % db.regions.length] : env.LOCATION_HINT));

// Where shard i's primary lives, and which replica (if any) a router here should read it from: one in
// this router's region, else a neighbouring one, unless the primary is at least as close.
const NEAR = { wnam: ["enam"], enam: ["wnam"], sam: ["enam", "wnam"], weur: ["eeur"], eeur: ["weur"], me: ["eeur", "weur"], afr: ["weur", "eeur"], apac: ["oc"], oc: ["apac"] };
function replicaRegion(env, db, i) {
  const mine = db.replicas && REGION_OF.get(live.colo);
  if (!mine) return null;
  // The home region has a replica too: the primary's replies wait for its storage commits, a replica's don't.
  for (const r of [mine, ...NEAR[mine]]) if (db.replicas.includes(r)) return r;
  return null;
}
export const replicaStub = (env, db, i, region) => shardNs(env, db, i).getByName(replicaName(shardName(db, i), region), objectOptions(env, region));
/** Tell every primary shard of a replicated database where to keep its replicas (idempotent). */
export const configureReplicas = (env, db) =>
  Promise.all(Array.from({ length: db.shards }, (_, i) => shardStub(env, db, i).replicate(db.replicas)));

export function database(env, name, shards, regions, replicas, classes) {
  let db = dbs.get(name);
  if (!db) {
    db = env.CATALOG.getByName("catalog").get(name, shards, regions, replicas, classes);
    db.catch(() => dbs.delete(name));
    dbs.set(name, db);
  }
  return db;
}

function commands(env) {
  // Any Valkey answers COMMAND the same way; a dedicated object keeps it off data shards.
  if (!table) {
    table = env.SHARD.getByName("__meta", objectOptions(env)).run([["COMMAND"]]).then((r) => commandTable(r[0]));
    table.catch(() => { table = null; });
  }
  return table;
}

const handles = (env, db) => ({
  db, shard: (i) => shardStub(env, db, i), pubsub: () => shardStub(env, db, "pubsub"),
  replica: (i) => { const r = replicaRegion(env, db, i); return r && replicaStub(env, db, i, r); },
});

// ---- live activity for ui/, reported to the Pulse object when a PULSE binding exists ----
// Isolate-wide, so one report covers every connection here. Each connection flushes from its own
// timer, so no request does I/O on behalf of another.
// `done` counts the commands of connections that have closed, per database, so short connections still count.
const live = { isolate: null, colo: null, coloTried: 0, conns: new Map(), flushed: 0, done: {} };
function learnColo() {
  const now = Date.now();
  if (live.colo || now - live.coloTried < 10_000) return;
  live.coloTried = now;
  coloOf().then((c) => { live.colo ??= c; }, () => {});
}
function report(env, minGap = PULSE_MS) {
  const now = Date.now();
  if (!env.PULSE || now - live.flushed < minGap) return;
  live.flushed = now;
  const conns = [...live.conns.values()].map(({ router, ...c }) => ({ ...c, db: router?.db.name ?? c.db, commands: router?.commands ?? 0 }));
  env.PULSE.getByName("pulse").report({ isolate: live.isolate, colo: live.colo, conns, done: live.done }).catch(() => {});
}

// One client connection (TCP or WebSocket) -> one Router on database `name`, until it closes.
// `via` is how it arrived ("tcp", "ws" or "binding"); `where` is what's known of the client's location.
async function serve(socket, env, name, via = "tcp", where = null) {
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

async function serveRouter(socket, env, name, conn) {
  let db, t;
  try {
    [db, t] = await Promise.all([database(env, name), commands(env)]);
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
    open: async (n) => handles(env, await database(env, n)),
    idleMs: Number(env.ROUTER_IDLE_MS || IDLE_MS),
  });
  conn.router = router;
  report(env);
  await router.run();
}

// A WebSocket as the { readable, writable } a Router reads and writes. WebSockets can't push back
// on the sender, so a client that outruns the router by WS_MAX_QUEUED bytes is disconnected.
function wsSocket(ws) {
  ws.binaryType = "arraybuffer"; // newer compat dates default to "blob"
  let ctrl;
  const readable = new ReadableStream({ start: (c) => { ctrl = c; } }, { highWaterMark: WS_MAX_QUEUED, size: (b) => b.byteLength });
  const end = () => { try { ctrl.close(); } catch { /* already closed */ } };
  ws.addEventListener("message", (e) => {
    try {
      ctrl.enqueue(typeof e.data === "string" ? new TextEncoder().encode(e.data) : new Uint8Array(e.data));
    } catch { return; }
    if (ctrl.desiredSize < 0) { ws.close(1009, "sending faster than the server reads"); end(); }
  });
  ws.addEventListener("close", end);
  ws.addEventListener("error", end);
  const writable = new WritableStream({
    write: (b) => ws.send(b),
    close: () => { try { ws.close(1000); } catch { /* gone */ } },
    abort: () => { try { ws.close(1011); } catch { /* gone */ } },
  });
  return { readable, writable };
}

export default {
  // Database = the host the caller dialed: env.VALKEY.connect("<db>:6379"), or AUTH <db> <pass>.
  async connect(socket, env) {
    const { localAddress, remoteAddress } = await socket.opened;
    // A raw TCP listener (local dev) and Spectrum report an address; treat IPs/localhost as "default".
    // A service binding reports the host the caller dialed.
    const host = (localAddress ?? "").replace(/:\d+$/, "");
    const tcp = !host || host === "localhost" || /^[\d.]+$|^\[/.test(host);
    await serve(socket, env, tcp ? "default" : host, tcp ? "tcp" : "binding", remoteAddress ? { addr: remoteAddress } : null);
  },

  // GET /ws upgrades to a WebSocket carrying raw RESP (scripts/ws-shim.mjs turns it back into a
  // local TCP port). Public, so it is only served when VALKEY_PASSWORD makes AUTH mandatory, and the
  // database comes from AUTH <db> <password>: nothing is created for unauthenticated callers.
  fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname !== "/ws") return bench(req, env, ctx);
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
    if (!env.VALKEY_PASSWORD) return new Response("WebSocket ingress needs VALKEY_PASSWORD set", { status: 403 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const cf = req.cf ?? {};
    live.colo ??= cf.colo ?? null;
    ctx.waitUntil(serve(wsSocket(server), env, "default", "ws", { colo: cf.colo, city: cf.city, country: cf.country, lat: Number(cf.latitude), lon: Number(cf.longitude) }));
    return new Response(null, { status: 101, webSocket: client });
  },
};
