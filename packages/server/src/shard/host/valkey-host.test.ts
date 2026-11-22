import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { command } from "../../protocol/resp";
import { fakeStorage } from "../vfs/fake-storage";
import { Vfs } from "../vfs/vfs";
import { ValkeyHost } from "./valkey-host";

const wasm = new WebAssembly.Module(readFileSync(new URL("../../../../wasm/valkey/valkey.wasm", import.meta.url)));

const args = [
  "--port",
  "6379",
  "--bind",
  "127.0.0.1",
  "--protected-mode",
  "no",
  "--dir",
  "/data",
  "--save",
  "",
  "--logfile",
  "",
  "--loglevel",
  "warning",
  "--appendonly",
  "yes",
];

const aof = [...args, "--appendfsync", "always", "--appenddirname", "aof", "--auto-aof-rewrite-percentage", "0"];
const decoder = new TextDecoder();

const run = async (host: ValkeyHost, ...argv: string[]) => decoder.decode(await host.execBatch(command(argv), 1));

test("valkey.wasm writes its AOF to the Vfs and loads it again", async () => {
  const storage = fakeStorage();
  const host = new ValkeyHost(wasm, storage, { args: aof, log: () => {} });
  const appended: number[] = [];
  host.onAppend = (b) => appended.push(b.length);
  assert.equal(await run(host, "SET", "k", "v1"), "+OK\r\n");
  assert.equal(await run(host, "APPEND", "k", "x"), ":3\r\n");
  assert.equal(await run(host, "GET", "k"), "$3\r\nv1x\r\n");
  assert.equal(appended.length, 2);
  assert.ok(host.files().some((f) => f.path.endsWith(".incr.aof") && f.size > 0));
  assert.deepEqual(host.files(), new Vfs(storage).listing());

  const again = new ValkeyHost(wasm, storage, { args: aof, log: () => {} });
  assert.equal(await run(again, "GET", "k"), "$3\r\nv1x\r\n");
  assert.match(await run(again, "BGREWRITEAOF"), /^\+/);
  assert.equal(await run(again, "SET", "j", "w"), "+OK\r\n");
  assert.deepEqual(again.files(), new Vfs(storage).listing());

  const third = new ValkeyHost(wasm, storage, { args: aof, log: () => {} });
  assert.equal(await run(third, "MGET", "k", "j"), "*2\r\n$3\r\nv1x\r\n$1\r\nw\r\n");
  assert.equal(third.stats().sockets, 0);
});

test("a served socket gets its greeting and replies, and drain closes it with the farewell", async () => {
  let syncs = 0;

  const host = new ValkeyHost(wasm, fakeStorage(), {
    args: aof,
    log: () => {},
    sync: async () => {
      syncs++;
    },
  });

  const input = new TransformStream<Uint8Array, Uint8Array>();
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const served = host.serve({ readable: input.readable, writable: output.writable }, "hi\r\n", false, "bye\r\n");
  const reader = output.readable.getReader();
  let got = "";

  const readUntil = async (end: string) => {
    while (!got.endsWith(end)) {
      const { value, done } = await reader.read();

      if (done) break;
      got += decoder.decode(value);
    }
  };

  await input.writable.getWriter().write(command(["SET", "a", "1"]));
  await readUntil("+OK\r\n");
  assert.equal(got, "hi\r\n+OK\r\n");
  assert.equal(host.stats().sockets, 1);
  assert.equal(host.stats().cronRunning, true);
  assert.ok(host.lastActive > 0);
  assert.ok(syncs > 0); // the SET's commit

  const [report] = await Promise.all([host.drain(), readUntil("bye\r\n")]);
  await served;
  assert.deepEqual(report, { clients: 1, closed: true });
  assert.equal(got, "hi\r\n+OK\r\nbye\r\n");
  assert.equal(host.stats().cronRunning, false);
});
