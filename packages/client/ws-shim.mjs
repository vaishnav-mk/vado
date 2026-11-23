#!/usr/bin/env node
// node packages/client/ws-shim.mjs wss://<your-worker>.workers.dev/ws 6379, then AUTH <db> <password>. WS_HEADER="name: value" adds an
// upgrade header; closes other than 1000 are logged, and WS_DEBUG=1 logs every close. Acks (vado-acks) stop the server when the local client stops reading.
import net from "node:net";

const [url = "ws://localhost:5173/ws", port = "6379"] = process.argv.slice(2);
const HIGH = 8 << 20; // pause the TCP side while this much is queued on the WebSocket
const ACK_EVERY = 256 << 10; // say how much has been taken at least this often, and whenever the TCP side drains

const server = net.createServer((sock) => {
  sock.setNoDelay(true);
  const header = process.env.WS_HEADER?.match(/^([^:]+):\s*(.*)$/);
  const options = { protocols: ["vado-acks"] };

  if (header) options.headers = { [header[1]]: header[2] };
  const ws = new WebSocket(url, options);
  ws.binaryType = "arraybuffer";
  const early = [];
  let timer = null;

  const send = (d) => {
    ws.send(d);

    if (ws.bufferedAmount > HIGH && !timer) {
      sock.pause();
      timer = setInterval(() => {
        if (ws.bufferedAmount < HIGH / 4) {
          clearInterval(timer);
          timer = null;
          sock.resume();
        }
      }, 5);
    }
  };

  ws.onopen = () => {
    for (const d of early.splice(0)) send(d);
  };

  let received = 0,
    acked = 0;

  ws.onmessage = (e) => {
    const b = Buffer.from(e.data),
      upTo = (received += b.length);

    sock.write(b, () => {
      if (
        ws.protocol !== "vado-acks" ||
        ws.readyState !== WebSocket.OPEN ||
        (upTo - acked < ACK_EVERY && sock.writableLength)
      )
        return;
      acked = upTo;
      ws.send(String(upTo));
    });
  };

  ws.onclose = (e) => {
    if (e.code !== 1000 || process.env.WS_DEBUG) console.error(`ws close ${e.code} ${e.reason}`);
    sock.destroy();
  };

  ws.onerror = () => sock.destroy();
  sock.on("data", (d) => (ws.readyState === WebSocket.OPEN ? send(d) : early.push(d)));
  sock.on("close", () => {
    clearInterval(timer);
    ws.close(1000);
  });
  sock.on("error", () => ws.close());
});

server.listen(Number(port), "127.0.0.1", () => console.log(`ws-shim: 127.0.0.1:${port} -> ${url}`));
