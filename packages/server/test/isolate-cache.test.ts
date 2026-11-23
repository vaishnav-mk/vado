import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { IsolateCache } from "../src/isolate-cache";

test("concurrent gets share one fetch, and later ones use the value", async () => {
  const cache = new IsolateCache<string, { n: number }>();
  let fetches = 0;
  const fetch = async () => ({ n: ++fetches });

  const [a, b] = await Promise.all([cache.get("k", fetch), cache.get("k", fetch)]);

  assert.equal(a, b);
  assert.equal(await cache.get("k", fetch), a);
  assert.equal(fetches, 1);
});

test("a waiter whose shared fetch fails fetches for itself, and failures aren't kept", async () => {
  const cache = new IsolateCache<string, { n: number }>();
  let fetches = 0;

  const failing = cache.get("k", async () => {
    fetches++;
    throw new Error("its request ended");
  });

  const waiter = cache.get("k", async () => ({ n: ++fetches }));

  await assert.rejects(failing, /its request ended/);
  assert.deepEqual(await waiter, { n: 2 });
  assert.equal(cache.peek("k")?.n, 2);
});

test("delete forgets the value", async () => {
  const cache = new IsolateCache<string, { n: number }>();
  await cache.get("k", async () => ({ n: 1 }));

  assert.equal(cache.delete("k"), true);
  assert.equal(cache.peek("k"), undefined);
});
