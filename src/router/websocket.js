// A WebSocket as the { readable, writable } a Router reads and writes. WebSockets can't push back
// on the sender, so a client that outruns the router by WS_MAX_QUEUED bytes is disconnected.
import { WS_MAX_QUEUED } from "../constants.js";

export function wsSocket(ws) {
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
