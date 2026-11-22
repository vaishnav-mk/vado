// A Durable Object placed in one region, so its connections, and the routers serving them, start there:
// traffic that enters Cloudflare far from whoever asked for it. run() is one bench test; loop() is the
// dashboard's test traffic, one round per alarm until its deadline or stop().
import { DurableObject } from "cloudflare:workers";
import { runTest } from "./bench.js";

const ROUND = { n: "20000", batch: "500", conns: "4" }; // 20,000 keys over 4 connections
const RETRY_MS = 2_000;

export class Sender extends DurableObject {
  async run(params) {
    const q = new URLSearchParams(params);
    return await runTest(q.get("test") ?? "throughput", this.env, q);
  }

  /** Test traffic on database `db` until `until`: write the same 20,000 keys, then read them back three
   *  times, like a cache. The keys never change, so test traffic never fills the database. */
  async loop(db, prefix, until) {
    await this.ctx.storage.put("loop", { id: crypto.randomUUID(), db, prefix, until, round: 0 });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async stop() {
    await this.ctx.storage.delete("loop");
    await this.ctx.storage.deleteAlarm();
  }

  // One round per alarm, so each round has the budget of a fresh request.
  async alarm() {
    const loop = await this.ctx.storage.get("loop");
    if (!loop) return;
    if (Date.now() >= loop.until) return await this.ctx.storage.delete("loop");
    let next = Date.now();
    try {
      await runTest("throughput", this.env, new URLSearchParams({ ...ROUND, db: loop.db, prefix: loop.prefix, ...(loop.round % 4 ? { op: "get" } : {}) }));
    } catch { next += RETRY_MS; } // a shard restarting, say
    if ((await this.ctx.storage.get("loop"))?.id !== loop.id) return; // stop(), or a new loop(), ran meanwhile
    await this.ctx.storage.put("loop", { ...loop, round: loop.round + 1 });
    await this.ctx.storage.setAlarm(next);
  }
}
