import { expect, test } from "vite-plus/test";
import { notWhileSubscribed } from "../../src/router/replies-text";
import { bulkOf, client, fakeShard } from "./fake-shard";

const dec = new TextDecoder();
const confirm = (kind: string, channel: string, n: number) => `*3\r\n${bulkOf(kind)}${bulkOf(channel)}:${n}\r\n`;

function pubsubShard() {
  let subscribed = 0;

  return fakeShard(([name, ...channels]) => {
    switch (name) {
      case "SUBSCRIBE":
        return channels.map((ch) => confirm("subscribe", ch, ++subscribed)).join("");
      case "UNSUBSCRIBE":
        return channels.map((ch) => confirm("unsubscribe", ch, --subscribed)).join("");
      case "PING":
        return `*2\r\n${bulkOf("pong")}${bulkOf("")}`;
      case "RESET":
        return "+RESET\r\n";
    }

    return "-ERR unexpected\r\n";
  });
}

test("a RESP2 subscriber gets the shard's frames until an unsubscribe leaves no channels", async () => {
  const shard = pubsubShard(),
    c = client([shard.stub], shard.stub);

  const next = async (want: string) => expect(await c.read(want.length)).toBe(want);

  await c.call("SUBSCRIBE", "a", "b");
  await next(confirm("subscribe", "a", 1) + confirm("subscribe", "b", 2));

  const message = `*3\r\n${bulkOf("message")}${bulkOf("a")}${bulkOf("0")}`;
  await shard.send(message);
  await next(message);

  await c.call("GET", "k");
  await next(dec.decode(notWhileSubscribed("get")));

  await c.call("PING");
  await next(`*2\r\n${bulkOf("pong")}${bulkOf("")}`);

  await c.call("UNSUBSCRIBE", "a");
  await next(confirm("unsubscribe", "a", 1));
  await c.call("GET", "k");
  await next(dec.decode(notWhileSubscribed("get")));

  await c.call("UNSUBSCRIBE", "b");
  await next(confirm("unsubscribe", "b", 0));
  await c.call("PING");
  await next("+PONG\r\n");

  expect(shard.got).toEqual([["SUBSCRIBE", "a", "b"], ["PING"], ["UNSUBSCRIBE", "a"], ["UNSUBSCRIBE", "b"]]);
  await c.close();
});

test("RESET from the shard ends passthrough", async () => {
  const shard = pubsubShard(),
    c = client([shard.stub], shard.stub);

  await c.call("SUBSCRIBE", "a");
  expect(await c.read(confirm("subscribe", "a", 1).length)).toBe(confirm("subscribe", "a", 1));

  await c.call("RESET");
  expect(await c.read(8)).toBe("+RESET\r\n");
  await c.call("PING");
  expect(await c.read(7)).toBe("+PONG\r\n");
  await c.close();
});

test("UNSUBSCRIBE while not subscribed is answered without reaching the shard", async () => {
  const shard = pubsubShard(),
    c = client([shard.stub], shard.stub);

  await c.call("UNSUBSCRIBE");
  const want = `*3\r\n${bulkOf("unsubscribe")}$-1\r\n:0\r\n`;
  expect(await c.read(want.length)).toBe(want);
  expect(shard.connects()).toBe(0);
  await c.close();
});
