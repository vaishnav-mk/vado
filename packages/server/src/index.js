// The database's side of the Worker. worker(app) is its default export: connect() takes a client connection (TCP
// through Spectrum, or a service binding) to a sharding Router; fetch() serves /ws (RESP over a WebSocket), /live
// (a database's numbers, for the dashboard) and, with a bearer token, the bench API, and hands anything else to
// `app` (the dashboard). The Durable Object classes it needs are in ./objects.js.
import { serve, live } from "./router/serve.js";
import { ACKS, wsSocket } from "./router/websocket.js";
import { bench } from "./bench/bench.js";
import { current } from "./catalog/databases.js";
import { DB_NAME } from "./catalog/catalog.js";
import { accessUser } from "./admin/access.js";
import { SIGNED_IN } from "./admin/watcher.js";

export { Admin } from "./admin/admin.js";

export { accessUser } from "./admin/access.js";

export { FLAVOURS } from "./shard/servers.js";

/** The Worker's handlers: the database's, and `app.fetch` for every other request. */
export const worker = (app) => ({
  // Database = the host the caller dialed: env.VALKEY.connect("<db>:6379"), or AUTH <db> <pass>.
  async connect(socket, env) {
    const { localAddress, remoteAddress } = await socket.opened;
    // Spectrum reports an address; treat IPs/localhost as "default". A service binding reports the host dialed.
    const host = (localAddress ?? "").replace(/:\d+$/, "");
    const tcp = !host || host === "localhost" || /^[\d.]+$|^\[/.test(host);
    await serve(
      socket,
      env,
      tcp ? "default" : host,
      tcp ? "tcp" : "binding",
      remoteAddress ? { addr: remoteAddress } : null,
    );
  },

  fetch(req, env, ctx) {
    const { pathname } = new URL(req.url);

    if (pathname === "/ws") return websocket(req, env, ctx);

    if (pathname === "/live") return watch(req, env);

    if (req.headers.get("authorization")?.startsWith("Bearer ")) return bench(req, env, ctx);

    return app.fetch(req, env, ctx);
  },
});

// GET /live?db=<name> upgrades to a WebSocket that the database's Watcher sends its numbers on, once a second.
// Public and read-only: counts, sizes and places, never keys, values or client addresses.
async function watch(req, env) {
  const name = new URL(req.url).searchParams.get("db") ?? "";

  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return new Response("expected a WebSocket upgrade", { status: 426 });

  if (!DB_NAME.test(name)) return new Response("no such database", { status: 404 });
  const db = await current(env, name).catch(() => null);

  if (!db || db.dropped) return new Response("no such database", { status: 404 });
  // The Watcher writes its probe key only while someone signed in watches; only this says who is.
  const headers = new Headers(req.headers);
  headers.delete(SIGNED_IN);

  if (await accessUser(req, env)) headers.set(SIGNED_IN, "1");

  return env.WATCHER.getByName(name).fetch(new Request(req, { headers }));
}

// GET /ws upgrades to a WebSocket carrying raw RESP (@vado/client's shim turns it back into a local TCP port).
// Public, so it is only served when VALKEY_PASSWORD makes AUTH mandatory, and the database comes from
// AUTH <db> <password>: nothing is created for unauthenticated callers.
function websocket(req, env, ctx) {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return new Response("expected a WebSocket upgrade", { status: 426 });

  if (!env.VALKEY_PASSWORD) return new Response("WebSocket ingress needs VALKEY_PASSWORD set", { status: 403 });
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  const acks = (req.headers.get("sec-websocket-protocol") ?? "").split(",").some((p) => p.trim() === ACKS);
  const cf = req.cf ?? {};
  live.colo ??= cf.colo ?? null;

  const where = {
    addr: req.headers.get("cf-connecting-ip"),
    colo: cf.colo,
    city: cf.city,
    country: cf.country,
    lat: Number(cf.latitude),
    lon: Number(cf.longitude),
  };

  ctx.waitUntil(serve(wsSocket(server, acks), env, "default", "ws", where));

  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: acks ? { "sec-websocket-protocol": ACKS } : {},
  });
}
