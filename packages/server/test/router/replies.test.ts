import { expect, test } from "vite-plus/test";
import { error, simple } from "../../src/protocol/resp";
import { ReplyQueue } from "../../src/router/replies";
import { LOST } from "../../src/router/replies-text";
import { DATABASE_DROPPED } from "../../src/shard/stats";

const dec = new TextDecoder();
const settle = () => new Promise((r) => setTimeout(r, 0));

function queue() {
  const writes: string[] = [];

  const writer = new WritableStream<Uint8Array>({
    write: (chunk) => {
      writes.push(dec.decode(chunk));
    },
  }).getWriter();

  const owner = { wake: () => {}, close: () => {}, dropped: () => error("ERR database x was dropped") };

  return { replies: new ReplyQueue(writer, owner), writes };
}

test("replies leave in request order, a pipeline's ready replies as one write", async () => {
  const { replies, writes } = queue();

  const a = replies.slot(),
    b = replies.slot(),
    c = replies.slot();

  replies.resolve(c, simple("c"));
  replies.resolve(b, simple("b"));
  await settle();
  expect(writes, "nothing before the first reply").toEqual([]);

  replies.resolve(a, simple("a"));
  await settle();
  expect(writes).toEqual(["+a\r\n+b\r\n+c\r\n"]);
});

test("an RPC-path command runs after every earlier reply, and holds later requests", async () => {
  const { replies, writes } = queue();

  const first = replies.slot(),
    order: string[] = [];

  replies.viaRpc(() => {
    order.push("rpc");

    return simple("rpc");
  });
  expect(replies.pending, "later requests wait").not.toBe(null);
  await settle();
  expect(order, "not before the earlier reply").toEqual([]);

  replies.resolve(first, simple("first"));
  await settle();
  expect(order).toEqual(["rpc"]);
  expect(writes.join("")).toBe("+first\r\n+rpc\r\n");
  expect(replies.pending, "released once its reply is in place").toBe(null);
});

test("an RPC that rejects gets LOST, or the dropped error", async () => {
  const { replies, writes } = queue();

  replies.viaRpc(() => Promise.reject(new Error("network")));
  replies.viaRpc(() => Promise.reject(new Error(DATABASE_DROPPED)));
  await settle();
  await settle();
  expect(writes.join("")).toBe(dec.decode(LOST) + "-ERR database x was dropped\r\n");
});

test("pushes wait for owed replies; drain resolves once nothing is owed", async () => {
  const { replies, writes } = queue();
  const s = replies.slot();

  replies.push(simple("push"));
  const drained = replies.drain(60_000);
  replies.resolve(s, simple("reply"));
  await drained;
  await settle();
  expect(writes.join("")).toBe("+reply\r\n+push\r\n");
});
