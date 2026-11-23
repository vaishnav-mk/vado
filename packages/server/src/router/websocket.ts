// A WebSocket as the { readable, writable } a Router reads and writes. WebSockets can't push back on the sender, so
// a client that outruns the router by WS_MAX_QUEUED bytes is disconnected. Nor can a Worker tell what the client
// has read, so with acks (the "vado-acks" subprotocol) the client sends text messages with the bytes it has taken,
// and writes wait while WS_UNACKED are outstanding. Without acks, replies go as fast as the router makes them.
import { WS_MAX_QUEUED, WS_UNACKED } from "./config";
import type { ClientSocket } from "./types";
import { encoder } from "../shared";

export const ACKS = "vado-acks";

const quietly = (f: () => void) => {
  try {
    f();
  } catch {
    // already closed
  }
};

export function wsSocket(ws: WebSocket, acks = false): ClientSocket {
  // newer compat dates default to "blob"
  ws.binaryType = "arraybuffer";
  let input: ReadableStreamDefaultController<Uint8Array> | null = null;

  const readable = new ReadableStream<Uint8Array>(
    {
      start: (c) => {
        input = c;
      },
    },
    { highWaterMark: WS_MAX_QUEUED, size: (b) => b.byteLength },
  );

  let sent = 0,
    acked = 0,
    resume: (() => void) | null = null;

  const wake = () => {
    const r = resume;
    resume = null;
    r?.();
  };

  const end = () => {
    wake();
    quietly(() => input?.close());
  };

  ws.addEventListener("message", (e) => {
    const data: ArrayBuffer | string = e.data;

    if (acks && !(data instanceof ArrayBuffer)) {
      // a text message: the bytes the client has taken so far
      acked = Math.max(acked, Number(data) || 0);

      if (sent - acked <= WS_UNACKED / 2) wake();

      return;
    }

    try {
      input?.enqueue(data instanceof ArrayBuffer ? new Uint8Array(data) : encoder.encode(data));
    } catch {
      return;
    }

    if ((input?.desiredSize ?? 0) < 0) {
      ws.close(1009, "sending faster than the server reads");
      end();
    }
  });
  ws.addEventListener("close", end);
  ws.addEventListener("error", end);

  const writable = new WritableStream<Uint8Array>({
    write: async (b) => {
      ws.send(b);
      sent += b.byteLength;

      if (acks && sent - acked > WS_UNACKED)
        await new Promise<void>((r) => {
          resume = r;
        });
    },
    close: () => quietly(() => ws.close(1000)),
    abort: () => quietly(() => ws.close(1011)),
  });

  return { readable, writable };
}
