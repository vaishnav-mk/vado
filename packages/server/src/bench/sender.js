// A Durable Object placed in one region, so its connections, and the routers serving them, start there:
// traffic that enters Cloudflare far from whoever asked for it. run() is one bench test; loop() is the
// dashboard's test traffic, one round per alarm until its deadline or stop().
import { DurableObject } from "cloudflare:workers";
import { runTest } from "./bench.js";

const ROUND = { n: "20000", batch: "500", conns: "4" }; // 20,000 commands over 4 connections
const RETRY_MS = 2_000;

export class Sender extends DurableObject {
  async run(params) {
    const q = new URLSearchParams(params);
    return await runTest(q.get("test") ?? "throughput", this.env, q);
  }

  /** Test traffic on database `db` until `until`: write the same `keys` keys (at most 20,000), then read them
   *  back three times, like a cache. The keys never change, so test traffic never grows the database. */
  async loop(db, prefix, until, keys = 20_000) {
    await this.ctx.storage.put("loop", { id: crypto.randomUUID(), db, prefix, until, keys, round: 0 });
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
      const keys = String(Math.max(1, Math.ceil((loop.keys ?? 20_000) / Number(ROUND.conns)))); // per connection
      const q = new URLSearchParams({ ...ROUND, keys, db: loop.db, prefix: loop.prefix });
      if (loop.round % 4) q.set("op", "get");
      await runTest("throughput", this.env, q);
    } catch { next += RETRY_MS; } // a shard restarting, say
    if ((await this.ctx.storage.get("loop"))?.id !== loop.id) return; // stop(), or a new loop(), ran meanwhile
    await this.ctx.storage.put("loop", { ...loop, round: loop.round + 1 });
    await this.ctx.storage.setAlarm(next);
  }
}
