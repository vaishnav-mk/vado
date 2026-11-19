#!/usr/bin/env node
// Expose valkey-do's WebSocket ingress as a local TCP port, so stock clients (redis-cli, ioredis,
// valkey-benchmark) can reach it: node scripts/ws-shim.mjs wss://<your-worker>.workers.dev/ws 6379
// One TCP connection = one WebSocket. Clients then AUTH <db> <password>.
import net from "node:net";

const [url = "ws://127.0.0.1:8787/ws", port = "6379"] = process.argv.slice(2);
const HIGH = 8 << 20; // pause the TCP side while this much is queued on the WebSocket

const server = net.createServer((sock) => {
  sock.setNoDelay(true);
  // WS_HEADER="name: value" adds a header to the WebSocket upgrade; WS_DEBUG=1 logs close codes.
  const header = process.env.WS_HEADER?.match(/^([^:]+):\s*(.*)$/);
  const ws = header ? new WebSocket(url, { headers: { [header[1]]: header[2] } }) : new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const early = [];
  let timer = null;
  const send = (d) => {
    ws.send(d);
    if (ws.bufferedAmount > HIGH && !timer) {
      sock.pause();
      timer = setInterval(() => { if (ws.bufferedAmount < HIGH / 4) { clearInterval(timer); timer = null; sock.resume(); } }, 5);
    }
  };
  ws.onopen = () => { for (const d of early.splice(0)) send(d); };
  ws.onmessage = (e) => sock.write(Buffer.from(e.data));
  ws.onclose = (e) => { if (process.env.WS_DEBUG) console.error(`ws close ${e.code} ${e.reason}`); sock.destroy(); };
  ws.onerror = () => sock.destroy();
  sock.on("data", (d) => (ws.readyState === WebSocket.OPEN ? send(d) : early.push(d)));
  sock.on("close", () => { clearInterval(timer); ws.close(); });
  sock.on("error", () => ws.close());
});
server.listen(Number(port), "127.0.0.1", () => console.log(`ws-shim: 127.0.0.1:${port} -> ${url}`));
