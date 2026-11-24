import { expect, test } from "vite-plus/test";
import { ROLE } from "../../src/container-shard/link";
import { proxy } from "../../src/container-shard/proxy";
import { bulk, command, concat, simple } from "../../src/protocol/resp";
import { encoder } from "../../src/shared";
import { end, send } from "./pipe";

test("a big request and a big reply in small reads pass whole in linear time, the reply after its fence", async () => {
  const n = 100_000;
  const request = command(["RPUSH", "l", ...Array.from({ length: n }, (_, i) => `v${i}`)]);
  const reply = concat([encoder.encode(`*${n}\r\n`), ...Array.from({ length: n }, (_, i) => bulk(`v${i}`))]);
  const role = encoder.encode("*3\r\n$6\r\nmaster\r\n:20\r\n*0\r\n");

  const fromClient = new TransformStream<Uint8Array, Uint8Array>(),
    fromServer = new TransformStream<Uint8Array, Uint8Array>(),
    toProxy = fromClient.writable.getWriter(),
    toServer = fromServer.writable.getWriter(),
    atServer: Uint8Array[] = [],
    atClient: Uint8Array[] = [],
    fenced: number[] = [],
    replied = Promise.withResolvers<void>();

  const client = end(fromClient, (chunk) => {
    atClient.push(chunk.slice());

    if (atClient.length === 2) replied.resolve(); // the greeting, then the batch's replies
  });

  const server = end(fromServer, (chunk) => {
    atServer.push(chunk.slice());
    send(toServer, concat([reply, role]));
  });

  const t0 = performance.now();
  const done = proxy(client, server, async (offset) => void fenced.push(offset), simple("hi"));

  send(toProxy, request);
  await replied.promise;
  expect(performance.now() - t0).toBeLessThan(2_000);
  await toProxy.close();
  await done;
  expect(concat(atServer)).toEqual(concat([request, ROLE]));
  expect(concat(atClient)).toEqual(concat([simple("hi"), reply]));
  expect(fenced).toEqual([20]);
});
