import { expect, test } from "vite-plus/test";
import { Mux } from "../../src/container-shard/mux";
import { command, concat, HELLO3, str } from "../../src/protocol/resp";
import type { Protocol } from "../../src/protocol/types";
import { encoder } from "../../src/shared";
import { end, send } from "./pipe";

test("a batch resolves with its replies, without ROLE's, once its fence is reached", async () => {
  const protos: Protocol[] = [2, 3];

  for (const proto of protos) {
    const fromServer = new TransformStream<Uint8Array, Uint8Array>(),
      toMux = fromServer.writable.getWriter(),
      fenced: number[] = [];

    const server = end(fromServer, (chunk) =>
      send(toMux, encoder.encode(chunk === HELLO3 ? "%0\r\n" : "+OK\r\n:5\r\n*3\r\n$6\r\nmaster\r\n:7\r\n*0\r\n")),
    );

    const mux = new Mux(server, async (offset) => void fenced.push(offset), proto);
    const replies = await mux.exec(concat([command(["SET", "a", "1"]), command(["INCR", "n"])]), 2);

    expect(str(replies)).toBe("+OK\r\n:5\r\n");
    expect(fenced).toEqual([7]);
    mux.close();
  }
});
