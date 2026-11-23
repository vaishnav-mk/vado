import { describe, expect, test } from "vite-plus/test";
import { BASE, BoxStore, LOG } from "../../src/box/store";
import { fakeStorage } from "../shard/vfs/fake-storage";

const stored = (store: BoxStore, gen: number, kind: typeof BASE | typeof LOG) =>
  [...store.chunks(gen, kind)].reduce((n, c) => n + c.length, 0);

describe("BoxStore", () => {
  test("counts bytes exactly from a generation's first chunk, and forgets dropped generations", () => {
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
    expect(store.bytes(1, BASE)).toBe(0);
    expect(store.bytes(2, BASE)).toBe(30);
    expect(new BoxStore(storage).bytes(2, BASE)).toBe(30);
  });

  test("a restart drops generations newer than the current one: a compaction cut short", () => {
    const storage = fakeStorage();
    const store = new BoxStore(storage);

    store.append(1, BASE, new Uint8Array(10));
    store.switchTo({ gen: 1, replid: "r", offset: 0 });
    store.append(2, BASE, new Uint8Array(20));
    const restarted = new BoxStore(storage);

    expect(restarted.current()?.gen).toBe(1);
    expect(restarted.bytes(2, BASE)).toBe(0);
    expect(restarted.bytes(1, BASE)).toBe(10);
  });
});
