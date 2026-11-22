// A WebSocket as the { readable, writable } a Router reads and writes. WebSockets can't push back
// on the sender, so a client that outruns the router by WS_MAX_QUEUED bytes is disconnected. The other way,
// a Worker can't tell what the client has read, so with `acks` (the "vado-acks" subprotocol, which
// scripts/ws-shim.mjs speaks) the client sends text messages with the bytes it has taken so far, and writes
// wait while WS_UNACKED are outstanding. Without acks, replies are sent as fast as the router makes them.
import { WS_MAX_QUEUED, WS_UNACKED } from "../constants.js";

export const ACKS = "vado-acks";

export function wsSocket(ws, acks = false) {
  ws.binaryType = "arraybuffer"; // newer compat dates default to "blob"
  let ctrl;

  const readable = new ReadableStream(
    {
      start: (c) => {
        ctrl = c;
      },
    },
    { highWaterMark: WS_MAX_QUEUED, size: (b) => b.byteLength },
  );

  let sent = 0,
    acked = 0,
    resume = null;

  const wake = () => {
    const r = resume;
    resume = null;
    r?.();
  };

  const end = () => {
    wake();

    try {
      ctrl.close();
    } catch {
      /* already closed */
    }
  };

  ws.addEventListener("message", (e) => {
    if (acks && !(e.data instanceof ArrayBuffer)) {
      // a text message: bytes the client has taken so far
      acked = Math.max(acked, Number(e.data) || 0);

      if (sent - acked <= WS_UNACKED / 2) wake();

      return;
    }

    try {
      ctrl.enqueue(e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : new TextEncoder().encode(e.data));
    } catch {
      return;
    }

    if (ctrl.desiredSize < 0) {
      ws.close(1009, "sending faster than the server reads");
      end();
    }
  });
  ws.addEventListener("close", end);
  ws.addEventListener("error", end);

  const writable = new WritableStream({
    write: async (b) => {
      ws.send(b);
      sent += b.byteLength;

      if (acks && sent - acked > WS_UNACKED) await new Promise((r) => (resume = r));
    },
    close: () => {
      try {
        ws.close(1000);
      } catch {
        /* gone */
      }
    },
    abort: () => {
      try {
        ws.close(1011);
      } catch {
        /* gone */
      }
    },
  });

  return { readable, writable };
}
