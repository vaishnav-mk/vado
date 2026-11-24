import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { fakeStorage } from "../vfs/fake-storage";
import { viewsOf } from "../../../src/wasm-shard/vfs/memory";
import { Vfs } from "../../../src/wasm-shard/vfs/vfs";
import { Gauge } from "../../../src/wasm-shard/host/gauge";
import { received } from "../../../src/wasm-shard/host/internal";
import { Loop } from "../../../src/wasm-shard/host/loop";
import { Sockets } from "../../../src/wasm-shard/host/sockets";
import type { PooledClient, WasmExports } from "../../../src/wasm-shard/host/types";
import { wasiImports } from "../../../src/wasm-shard/host/wasi";

const encoder = new TextEncoder();

// Both builds' imports from `module`, from their interface.txt.
const imported = (module: string) =>
  [
    ...new Set(
      ["valkey", "redis"].flatMap((build) =>
        readFileSync(new URL(`../../../../wasm/${build}/interface.txt`, import.meta.url), "utf8")
          .split("\n")
          .filter((l) => l.startsWith(`import ${module}.`))
          .map((l) => l.split(" ")[1].slice(module.length + 1)),
      ),
    ),
  ].sort();

test("the host provides exactly the imports the wasm builds list", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const views = viewsOf(() => memory);
  const wasi = wasiImports(views, new Vfs(fakeStorage(), () => memory), () => {});
  assert.deepEqual(Object.keys(wasi).sort(), imported("wasi_snapshot_preview1"));
  const host = [...Object.keys(new Sockets().imports(views, { schedule() {}, closed() {} })), "aof_rewrite"];
  assert.deepEqual(host.sort(), imported("host"));
});

test("pooled replies are counted as they arrive in pieces", () => {
  const c: PooledClient = {
    alive: true,
    socket: new Sockets().add({ write: async () => {}, close: async () => {} }, true),
    out: new Uint8Array(0),
    len: 0,
    pos: 0,
    frames: 0,
    want: 3,
    resume: { k: 0, rel: 0 },
  };

  const replies = "+OK\r\n>2\r\n$1\r\na\r\n$1\r\nb\r\n*2\r\n$3\r\nfoo\r\n:12\r\n$-1\r\n";

  for (const piece of replies.match(/[\s\S]{1,3}/g) ?? []) received(c, encoder.encode(piece));

  assert.equal(c.frames, 3); // the push isn't a reply
  assert.equal(new TextDecoder().decode(c.out.subarray(0, c.pos)), replies);
});

test("a gauge resolves at zero", async () => {
  const gauge = new Gauge();
  await gauge.zero();
  gauge.up();
  gauge.up();
  let done = false;
  const waiting = gauge.zero().then(() => (done = true));
  gauge.down();
  await Promise.resolve();
  assert.equal(done, false);
  gauge.down();
  await waiting;
  assert.equal(done, true);
});

test("a loop never steps Valkey again once it has thrown", () => {
  let ticks = 0,
    fatal = 0;

  const rk_tick = () => {
    ticks++;
    throw new Error("trap");
  };

  const vk: WasmExports = {
    memory: new WebAssembly.Memory({ initial: 1 }),
    _initialize: () => {},
    rk_args_cap: () => 0,
    rk_args_ptr: () => 0,
    rk_boot_args: () => 0,
    rk_next_timeout_ms: () => 100,
    rk_rewrite_done: () => 0,
    rk_tick,
  };

  const stats = { writes: 0, writeBytes: 0, reads: 0, readBytes: 0, rowsWritten: 0 };

  const loop = new Loop(
    vk,
    new Sockets(),
    stats,
    undefined,
    () => fatal++,
    () => {},
  );

  assert.throws(() => loop.step(), /trap/);
  assert.throws(() => loop.step(), /trap/);

  assert.equal(ticks, 1);
  assert.equal(fatal, 1);
});
