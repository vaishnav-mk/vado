// Worker entry: TCP connect() -> sharding router; fetch() -> admin + bench (token-protected).
import { Router, setSocketBudget } from "./router.js";
import { commandTable } from "./commands.js";
import { bench } from "./bench.js";

export { ValkeyShard } from "./shard.js";
export { Catalog } from "./catalog.js";

const HINTS = new Set(["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"]);
// Per isolate, cache the promise, not the result: hundreds of connections landing on a cold isolate
// would otherwise all fetch the COMMAND table at once (796 RPCs in a minute, and the isolate hit its
// 128 MB limit). A failed lookup is dropped so the next connection retries.
const dbs = new Map(); // name -> Promise<db>; a database's record never changes once created
let table = null; // Promise<command table>

export const objectOptions = (env) => (HINTS.has(env.LOCATION_HINT) ? { locationHint: env.LOCATION_HINT } : {});
export const shardName = (db, i) => `${db.name}.${db.created.toString(36)}.${i}`;
export const shardStub = (env, db, i) => env.SHARD.getByName(shardName(db, i), objectOptions(env));

export function database(env, name, shards) {
  let db = dbs.get(name);
  if (!db) {
    db = env.CATALOG.getByName("catalog").get(name, shards);
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

const handles = (env, db) => ({ db, shard: (i) => shardStub(env, db, i), pubsub: () => shardStub(env, db, "pubsub") });

// One client connection (TCP or WebSocket) -> one Router on database `name`, until it closes.
async function serve(socket, env, name) {
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
    idleMs: Number(env.ROUTER_IDLE_MS || 30000),
  });
  await router.run();
}

// A WebSocket as the { readable, writable } a Router reads and writes. WebSockets can't push back
// on the sender, so a client that outruns the router by MAX_QUEUED bytes is disconnected.
const MAX_QUEUED = 16 << 20;
function wsSocket(ws) {
  ws.binaryType = "arraybuffer"; // newer compat dates default to "blob"
  let ctrl;
  const readable = new ReadableStream({ start: (c) => { ctrl = c; } }, { highWaterMark: MAX_QUEUED, size: (b) => b.byteLength });
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
    const { localAddress } = await socket.opened;
    // A raw TCP listener (local dev) and Spectrum report an address; treat IPs/localhost as "default".
    const host = (localAddress ?? "").replace(/:\d+$/, "");
    await serve(socket, env, !host || host === "localhost" || /^[\d.]+$|^\[/.test(host) ? "default" : host);
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
    ctx.waitUntil(serve(wsSocket(server), env, "default"));
    return new Response(null, { status: 101, webSocket: client });
  },
};
