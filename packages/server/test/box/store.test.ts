import { describe, expect, test } from "vite-plus/test";
import { BASE, BoxStore, LOG } from "../../src/box/store";
import { fakeStorage } from "../shard/vfs/fake-storage";

const stored = (store: BoxStore, gen: number, kind: typeof BASE | typeof LOG) =>
  [...store.chunks(gen, kind)].reduce((n, c) => n + c.length, 0);

describe("BoxStore", () => {
  test("counts bytes exactly from a generation's first chunk, and forgets replaced generations", () => {
    const storage = fakeStorage();
    const store = new BoxStore(storage);

    store.append(1, BASE, new Uint8Array(100));
    store.append(1, BASE, new Uint8Array(50));
    store.append(1, LOG, new Uint8Array(7));
    store.switchTo({ gen: 1, replid: "r", offset: 0 });
    expect(store.bytes(1, BASE)).toBe(150);
    expect(store.bytes(1, BASE)).toBe(stored(store, 1, BASE));
    expect(store.bytes(1, LOG)).toBe(7);

    store.append(2, BASE, new Uint8Array(30));
    store.switchTo({ gen: 2, replid: "r", offset: 10 });

    while (store.prune(1 << 20));
    expect(store.bytes(1, BASE)).toBe(0);
    expect(store.bytes(2, BASE)).toBe(30);
    expect(new BoxStore(storage).bytes(2, BASE)).toBe(30);
  });

  test("a sync never reuses a failed one's number, and prune removes the rest a batch at a time", () => {
    const storage = fakeStorage();
    const store = new BoxStore(storage);

    expect(store.begin()).toBe(1);
    store.append(1, BASE, new Uint8Array(10));
    store.switchTo({ gen: 1, replid: "r", offset: 0 });
    const failed = store.begin();

    for (let i = 0; i < 5; i++) store.append(failed, BASE, new Uint8Array(20));
    const retry = store.begin();

    expect(retry).toBe(failed + 1);
    expect(new BoxStore(storage).begin()).toBe(retry);
    store.append(retry, BASE, new Uint8Array(30));
    let batches = 0;

    while (store.prune(40)) batches++;
    expect(batches).toBe(2);
    expect(stored(store, failed, BASE)).toBe(0);
    expect(stored(store, 1, BASE)).toBe(10);
    expect(stored(store, retry, BASE)).toBe(30);
  });
});
