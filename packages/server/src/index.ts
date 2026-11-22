// The database's side of the Worker: connect() takes a client connection (TCP through Spectrum, or a service
// binding) to a sharding Router; fetch() serves /ws, /live and, with a bearer token, the bench API, and hands every
// other request to `app` (the dashboard). The Worker's entry module exports the Durable Object classes.
import { accessUser } from "./admin/access";
import { SIGNED_IN } from "./admin/watcher/watcher";
import { bench } from "./bench/bench";
import { current } from "./catalog/databases";
import { DB_NAME } from "./catalog/names";
import { live, serve } from "./router/serve";
import { ACKS, wsSocket } from "./router/websocket";

export { Admin } from "./admin/admin";

export { accessUser } from "./admin/access";

export { FLAVOURS } from "./shard/servers";

export type * from "./admin/live-types";

type IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/** What serves every request that isn't the database's. */
export interface App {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}

const upgradeRequired = () => new Response("expected a WebSocket upgrade", { status: 426 });
const isUpgrade = (req: Request) => req.headers.get("upgrade")?.toLowerCase() === "websocket";

/** The Worker's handlers: the database's, and `app.fetch` for every other request. */
export const worker = (app: App) => ({
  // The database is the host the caller dialed: env.VALKEY.connect("<db>:6379"), or AUTH <db> <pass>.
  async connect(socket: Socket, env: Env): Promise<void> {
    const { localAddress, remoteAddress } = await socket.opened;
    // Spectrum reports an address: IPs and localhost mean "default". A service binding reports the host dialed.
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

  fetch(req: IncomingRequest, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === "/ws") return websocket(req, env, ctx);

    if (pathname === "/live") return watch(req, env);

    if (req.headers.get("authorization")?.startsWith("Bearer ")) return bench(req, env);

    return app.fetch(req, env, ctx);
  },
});

// GET /live?db=<name> upgrades to the database's Watcher socket. Public and read-only: counts, sizes and places,
// never keys, values or client addresses.
async function watch(req: Request, env: Env): Promise<Response> {
  const name = new URL(req.url).searchParams.get("db") ?? "";

  if (!isUpgrade(req)) return upgradeRequired();

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
function websocket(req: IncomingRequest, env: Env, ctx: ExecutionContext): Response {
  if (!isUpgrade(req)) return upgradeRequired();

  if (!env.VALKEY_PASSWORD) return new Response("WebSocket ingress needs VALKEY_PASSWORD set", { status: 403 });
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  const acks = (req.headers.get("sec-websocket-protocol") ?? "").split(",").some((p) => p.trim() === ACKS);
  const cf = req.cf;
  live.colo ??= cf?.colo ?? null;

  const where = {
    addr: req.headers.get("cf-connecting-ip"),
    colo: cf?.colo,
    city: cf?.city,
    country: cf?.country,
    lat: Number(cf?.latitude),
    lon: Number(cf?.longitude),
  };

  ctx.waitUntil(serve(wsSocket(server, acks), env, "default", "ws", where));

  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: acks ? { "sec-websocket-protocol": ACKS } : {},
  });
}
