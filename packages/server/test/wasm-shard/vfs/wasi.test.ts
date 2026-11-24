import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { fakeStorage } from "./fake-storage";
import { iovecs, viewsOf } from "../../../src/wasm-shard/vfs/memory";
import { Vfs } from "../../../src/wasm-shard/vfs/vfs";
import { E, OFLAG, PREOPEN_FD } from "../../../src/wasm-shard/vfs/wasi-abi";
import { resolvePath } from "../../../src/wasm-shard/vfs/wasi-paths";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("resolvePath", () => {
  assert.equal(resolvePath("", "a/./b//c"), "a/b/c");
  assert.equal(resolvePath("dir", "../x"), "x");
  assert.equal(resolvePath("dir", "."), "dir");
});

test("iovecs", () => {
  const memory = new ArrayBuffer(64);
  const view = new DataView(memory);
  view.setUint32(0, 16, true);
  view.setUint32(4, 3, true);
  view.setUint32(8, 32, true);
  view.setUint32(12, 5, true);
  assert.deepEqual(
    iovecs(memory, view, 0, 2).map((b) => [b.byteOffset, b.length]),
    [
      [16, 3],
      [32, 5],
    ],
  );
});

test("WASI calls on files and directories", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });

  const vfs = new Vfs(
    fakeStorage(),
    viewsOf(() => memory),
  );

  const wasi = vfs.imports();
  const u8 = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const streamed: string[] = [];
  vfs.onAppend = (b) => streamed.push(decoder.decode(b));

  const path = (s: string): [number, number] => {
    const b = encoder.encode(s);
    u8.set(b, 1000);

    return [1000, b.length];
  };

  const open = (s: string, oflags: number) => {
    assert.equal(wasi.path_open(PREOPEN_FD, 0, ...path(s), oflags, 0n, 0n, 0, 2000), E.OK);

    return dv.getUint32(2000, true);
  };

  assert.equal(wasi.path_create_directory(PREOPEN_FD, ...path("aof")), E.OK);
  assert.equal(wasi.path_create_directory(PREOPEN_FD, ...path("aof")), E.EXIST);
  assert.equal(wasi.path_open(PREOPEN_FD, 0, ...path("aof/x"), 0, 0n, 0n, 0, 2000), E.NOENT);
  const fd = open("aof/x.incr.aof", OFLAG.CREAT);
  assert.equal(vfs.write(fd, [encoder.encode("hel"), encoder.encode("lo")]), E.OK);
  assert.deepEqual(streamed, ["hello"]);
  assert.equal(wasi.fd_sync(fd), E.OK);

  assert.equal(wasi.fd_seek(fd, 1n, 0, 2008), E.OK);
  dv.setUint32(3000, 4000, true);
  dv.setUint32(3004, 2, true);
  dv.setUint32(3008, 4100, true);
  dv.setUint32(3012, 10, true);
  assert.equal(wasi.fd_read(fd, 3000, 2, 2016), E.OK);
  assert.equal(dv.getUint32(2016, true), 4);
  assert.equal(decoder.decode(u8.subarray(4000, 4002)) + decoder.decode(u8.subarray(4100, 4102)), "ello");

  const [from, fromLen] = path("aof/x.incr.aof");
  u8.set(encoder.encode("aof/y.incr.aof"), 1100);
  assert.equal(wasi.path_rename(PREOPEN_FD, from, fromLen, PREOPEN_FD, 1100, 14), E.OK);
  assert.equal(vfs.write(fd, [encoder.encode("!")]), E.OK); // the open fd follows the rename
  wasi.fd_close(fd);
  assert.equal(decoder.decode(vfs.read("aof/y.incr.aof", 0, 100) ?? new Uint8Array()), "hello!");

  const dir = open("aof", OFLAG.DIRECTORY);
  assert.equal(wasi.fd_readdir(dir, 5000, 200, 0n, 2024), E.OK);
  const used = dv.getUint32(2024, true);
  assert.equal(used, 24 + "y.incr.aof".length);
  assert.equal(decoder.decode(u8.subarray(5024, 5000 + used)), "y.incr.aof");

  const gone = open("aof/y.incr.aof", 0);
  assert.equal(wasi.path_unlink_file(PREOPEN_FD, ...path("aof/y.incr.aof")), E.OK);
  assert.equal(vfs.write(gone, [encoder.encode("lost")]), E.OK); // writes to an unlinked-but-open file vanish
  assert.equal(vfs.size("aof/y.incr.aof"), null);
});

test("a closed fd is reused, so file fds never reach sock_shim's pipes at 3072", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });

  const wasi = new Vfs(
    fakeStorage(),
    viewsOf(() => memory),
  ).imports();

  const name = encoder.encode("f");
  new Uint8Array(memory.buffer).set(name, 1000);

  const open = () => {
    assert.equal(wasi.path_open(PREOPEN_FD, 0, 1000, name.length, OFLAG.CREAT, 0n, 0n, 0, 2000), E.OK);

    return new DataView(memory.buffer).getUint32(2000, true);
  };

  const kept = open();

  for (let i = 0; i < 3100; i++) {
    const fd = open();
    assert.equal(fd, kept + 1);
    assert.equal(wasi.fd_close(fd), E.OK);
  }
});
