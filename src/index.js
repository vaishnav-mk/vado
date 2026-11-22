// The database Worker. connect(): a client connection (TCP, or a service binding) -> a sharding Router.
// fetch(): /ws carries RESP over a WebSocket; requests with a bearer token are the bench API; anything
// else is the dashboard (the DASHBOARD service binding), when there is one.
import { serve, live } from "./router/serve.js";
import { wsSocket } from "./router/websocket.js";
import { bench } from "./bench/bench.js";

export { ValkeyShard, ValkeyShard1, ValkeyShard2, ValkeyShard3, ValkeyShard4, ValkeyShard5, ValkeyShard6, ValkeyShard7 } from "./shard/shard.js";
export { ValkeyShard8, ValkeyShard9, ValkeyShard10, ValkeyShard11, ValkeyShard12, ValkeyShard13, ValkeyShard14, ValkeyShard15 } from "./shard/shard.js";
export { ValkeyRewriter, ValkeyRewriter1, ValkeyRewriter2, ValkeyRewriter3, ValkeyRewriter4, ValkeyRewriter5, ValkeyRewriter6, ValkeyRewriter7 } from "./shard/rewriter.js";
export { Catalog } from "./catalog/catalog.js";
export { Pulse } from "./admin/pulse.js";
export { Sender } from "./bench/sender.js";

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

  fetch(req, env, ctx) {
    if (new URL(req.url).pathname === "/ws") return websocket(req, env, ctx);
    if (req.headers.has("authorization")) return bench(req, env, ctx);
    return env.DASHBOARD ? env.DASHBOARD.fetch(req) : new Response("not found", { status: 404 });
  },
};

// GET /ws upgrades to a WebSocket carrying raw RESP (scripts/ws-shim.mjs turns it back into a local TCP
// port). Public, so it is only served when VALKEY_PASSWORD makes AUTH mandatory, and the database comes
// from AUTH <db> <password>: nothing is created for unauthenticated callers.
function websocket(req, env, ctx) {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
  if (!env.VALKEY_PASSWORD) return new Response("WebSocket ingress needs VALKEY_PASSWORD set", { status: 403 });
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  const cf = req.cf ?? {};
  live.colo ??= cf.colo ?? null;
  ctx.waitUntil(serve(wsSocket(server), env, "default", "ws", { colo: cf.colo, city: cf.city, country: cf.country, lat: Number(cf.latitude), lon: Number(cf.longitude) }));
  return new Response(null, { status: 101, webSocket: client });
}
