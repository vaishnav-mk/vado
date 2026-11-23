import { expect, test } from "vite-plus/test";
import { replay } from "../../src/box/server";
import { command, concat } from "../../src/protocol/resp";
import { encoder } from "../../src/shared";

// A server that answers `replies` commands with +OK, keeping what it was sent.
function server(replies: number) {
  const sent: Uint8Array[] = [];

  const socket: Socket = {
    readable: new ReadableStream({ start: (c) => c.enqueue(encoder.encode("+OK\r\n".repeat(replies))) }),
    writable: new WritableStream({ write: (chunk) => void sent.push(chunk) }),
    opened: Promise.resolve({}),
    closed: new Promise(() => {}),
    upgraded: false,
    secureTransport: "off",
    close: async () => {},
    startTls: () => {
      throw new Error("no TLS");
    },
  };

  return { socket, sent };
}

test("a stream stored in tiny rows replays in linear time, and REPLCONF gets no reply", async () => {
  const stream = concat([
    command(["SET", "big", "x".repeat(16 << 20)]),
    command(["REPLCONF", "GETACK", "*"]),
    command(["PING"]),
  ]);

  const rows = Array.from({ length: Math.ceil(stream.length / 4096) }, (_, i) =>
    stream.subarray(i * 4096, (i + 1) * 4096),
  );

  const { socket, sent } = server(2);
  const t0 = performance.now();

  await replay(socket, rows);
  expect(performance.now() - t0).toBeLessThan(2_000);
  expect(concat(sent)).toEqual(stream);
});
