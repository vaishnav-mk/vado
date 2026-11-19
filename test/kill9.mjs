// Crash test: write keys through the router, kill -9 workerd mid-stream, restart, and check that
// every write that was acknowledged before the crash survived with the right value.
import Redis from "ioredis";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const local = new URL("../scripts/local.sh", import.meta.url).pathname;
const tag = `k${Date.now()}`;
const acked = new Map();
const r = new Redis({ port: 6380, host: "127.0.0.1", maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
r.on("error", () => {});
await new Promise((res) => r.once("ready", res));

let i = 0, stop = false;
const writers = Array.from({ length: 8 }, async () => {
  while (!stop) {
    const batch = Array.from({ length: 50 }, () => i++);
    const p = r.pipeline();
    for (const k of batch) p.set(`${tag}:${k}`, `v${k}`);
    try {
      const res = await p.exec();
      res.forEach(([err, ok], j) => { if (!err && ok === "OK") acked.set(`${tag}:${batch[j]}`, `v${batch[j]}`); });
      if (res.every(([err]) => err)) return; // connection gone
    } catch { return; }
  }
});

await new Promise((res) => setTimeout(res, Number(process.env.KILL_AFTER_MS ?? 1500)));
console.log("killing; acked so far", acked.size);
execFileSync("pkill", ["-9", "-f", "workerd serve config.capnp"]);
stop = true;
await Promise.allSettled(writers);
r.disconnect();
console.log(`killed after ${acked.size} acked writes (${i} attempted)`);

execFileSync(local, { stdio: "inherit" });
const r2 = new Redis({ port: 6380, host: "127.0.0.1" });
const keys = [...acked.keys()];
let missing = 0, wrong = 0;
for (let s = 0; s < keys.length; s += 1000) {
  const vals = await r2.mget(...keys.slice(s, s + 1000));
  vals.forEach((v, j) => { if (v === null) missing++; else if (v !== acked.get(keys[s + j])) wrong++; });
}
const total = (await r2.keys(`${tag}:*`)).length;
r2.disconnect();
console.log(JSON.stringify({ acked: acked.size, missing, wrong, keysPresentAfter: total }));
assert.equal(missing, 0);
assert.equal(wrong, 0);
console.log("kill -9 durability passed");
