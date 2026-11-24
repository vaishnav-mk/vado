import { expect, test } from "vite-plus/test";
import { RespClient } from "../../src/protocol/resp-client";

const enc = new TextEncoder();

// A server that sends `replies` in pieces of `size` bytes and ignores what it gets.
function server(replies: string, size: number) {
  const bytes = enc.encode(replies);
  let at = 0;

  const readable = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.length) c.close();
      else c.enqueue(bytes.slice(at, (at += size)));
    },
  });

  return { readable, writable: new WritableStream<Uint8Array>() };
}

test("replies split across chunks, with a frame left over for the next read", async () => {
  const big = "x".repeat(50_000),
    many = Array.from({ length: 2000 }, (_, i) => i);

  const replies = `$${big.length}\r\n${big}\r\n*${many.length}\r\n${many.map((i) => `:${i}\r\n`).join("")}-ERR no\r\n`;

  for (const size of [1, 7, 4096, replies.length]) {
    const c = new RespClient(server(replies, size), 1000);

    expect(await c.read(1)).toEqual([big]);
    expect(await c.read(2)).toEqual([many, { err: "ERR no" }]);
  }
});
