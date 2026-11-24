import { expect, test } from "vite-plus/test";
import { storeRdb } from "../../src/box/rdb";
import { BASE, BoxStore } from "../../src/box/store";
import { concat } from "../../src/protocol/resp";
import { encoder } from "../../src/shared";
import { fakeStorage } from "../shard/vfs/fake-storage";

const payload = Uint8Array.from({ length: 5 << 20 }, (_, i) => (i * 7) % 251);
const after = encoder.encode("*1\r\n$4\r\nPING\r\n");

// The transfer as the socket gives it: `bytes` in reads of `size`, the first `first` bytes already buffered.
function transfer(bytes: Uint8Array, size: number) {
  const reads = Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) =>
    bytes.subarray(i * size, (i + 1) * size),
  );

  const storage = fakeStorage();
  let syncs = 0;

  storage.sync = () => {
    syncs++;

    return Promise.resolve();
  };

  const store = new BoxStore(storage);
  const [first = new Uint8Array(0), ...rest] = reads;

  const read = async () => {
    const next = rest.shift();

    if (!next) throw new Error("replication link closed");

    return next;
  };

  return { store, first, read, syncs: () => syncs };
}

test("stores an RDB with a length, returns the bytes after it, and commits during the copy", async () => {
  for (const size of [4096, 65536, 1_000_003]) {
    const t = transfer(concat([payload, after]), size);
    const rest = await storeRdb(t.store, 1, `$${payload.length}`, t.first, t.read);

    expect(concat([...t.store.chunks(1, BASE)])).toEqual(payload);
    expect(concat([rest, ...(rest.length < after.length ? [await t.read()] : [])])).toEqual(after);
    expect(t.syncs()).toBeGreaterThan(0);
  }
});

test("stores a diskless RDB up to its mark, also when the mark is split across reads", async () => {
  const mark = "m".repeat(40);

  for (const size of [4096, 65536, 1_000_003, payload.length + 20]) {
    const t = transfer(concat([payload, encoder.encode(mark)]), size);

    await storeRdb(t.store, 1, `$EOF:${mark}`, t.first, t.read);
    expect(concat([...t.store.chunks(1, BASE)])).toEqual(payload);
    expect(t.syncs()).toBeGreaterThan(0);
  }
});
