import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { RespClient } from "../../src/protocol/resp-client";
import { socketPair } from "../../src/router/socket-pair";

test("a server that refuses without reading still reaches the client", async () => {
  const [client, server] = socketPair();
  const w = server.writable.getWriter();
  await w.write(new TextEncoder().encode("-ERR database dropped\r\n"));
  await w.close();

  const replies = await new RespClient(client, 1000).call(["AUTH", "secret"]);

  assert.deepEqual(replies, [{ err: "ERR database dropped" }]);
});
