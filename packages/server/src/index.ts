import { accessUser } from "./admin/access";
import { SIGNED_IN } from "./admin/watcher/watcher";
import { bench } from "./bench/bench";
import { existing } from "./catalog/databases";
import { DB_NAME } from "./catalog/names";
import { live, serve } from "./router/serve";
import { ACKS, wsSocket } from "./router/websocket";

export { Admin } from "./admin/admin";

export { accessUser } from "./admin/access";

export { FLAVOURS } from "./shard/servers";

export type * from "./admin/live-types";

type IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

export interface App {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}

const upgradeRequired = () => new Response("expected a WebSocket upgrade", { status: 426 });
const isUpgrade = (req: Request) => req.headers.get("upgrade")?.toLowerCase() === "websocket";

export const worker = (app: App) => ({
  async connect(socket: Socket, env: Env): Promise<void> {
    const { localAddress, remoteAddress } = await socket.opened;
    // A service binding reports the host dialed (the database); Spectrum reports an IP or localhost.
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

async function watch(req: Request, env: Env): Promise<Response> {
  const name = new URL(req.url).searchParams.get("db") ?? "";

  if (!isUpgrade(req)) return upgradeRequired();

  if (!DB_NAME.test(name) || !(await existing(env, name).catch(() => null)))
    return new Response("no such database", { status: 404 });
  // The Watcher writes its probe key only while someone signed in watches; only this header says who is.
  const headers = new Headers(req.headers);
  headers.delete(SIGNED_IN);

  if (await accessUser(req, env)) headers.set(SIGNED_IN, "1");

  return env.WATCHER.getByName(name).fetch(new Request(req, { headers }));
}

// Public, so served only when VALKEY_PASSWORD makes AUTH mandatory. Unauthenticated callers run no commands, but a
// connection still looks up the default database, creating it if it doesn't exist.
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
