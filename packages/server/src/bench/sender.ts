// A Durable Object placed in one region, so its connections, and the routers serving them, start there: traffic
// that enters Cloudflare far from whoever asked for it. run() is one bench test; loop() is the dashboard's test
// traffic, one round at a time until its deadline or stop().
import { DurableObject } from "cloudflare:workers";
import { DurabilityAlarms } from "durability";
import * as v from "valibot";
import { runTest } from "./bench";

const ROUND = { n: "20000", batch: "500", conns: "4" }; // 20,000 commands over 4 connections
const RETRY_MS = 2_000; // after a failed round: a shard restarting, say

const Loop = v.object({
  id: v.string(),
  db: v.string(),
  prefix: v.string(),
  until: v.number(),
  keys: v.number(),
  round: v.number(),
});

type Loop = v.InferOutput<typeof Loop>;

export class Sender extends DurableObject<Env> {
  readonly #alarms = new DurabilityAlarms({
    context: this.ctx,
    handlers: { round: () => this.#round(), deadline: () => this.#deadline() },
    methods: { round: { retries: { maxAttempts: 1 } } }, // a failed round schedules the next one itself
  });

  async run(params: Record<string, string>): Promise<object> {
    const q = new URLSearchParams(params);

    return await runTest(q.get("test") ?? "throughput", this.env, q);
  }

  /** Test traffic on database `db` until `until`: write the same `keys` keys, then read them back three times, like
   *  a cache. The keys never change, so test traffic never grows the database. */
  async loop(db: string, prefix: string, until: number, keys = 20_000): Promise<void> {
    await this.ctx.storage.put("loop", { id: crypto.randomUUID(), db, prefix, until, keys, round: 0 });
    await this.#alarms.round(Date.now());
    await this.#alarms.deadline(until);
  }

  async stop(): Promise<void> {
    await this.ctx.storage.delete("loop");
    await this.#alarms.round.cancel();
    await this.#alarms.deadline.cancel();
  }

  override alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.#alarms.alarm(info);
  }

  async #loop(): Promise<Loop | null> {
    const stored: unknown = await this.ctx.storage.get("loop");

    return v.is(Loop, stored) ? stored : null;
  }

  async #round(): Promise<void> {
    const loop = await this.#loop();

    if (!loop || Date.now() >= loop.until) return;
    let next = Date.now();

    try {
      const keys = String(Math.max(1, Math.ceil(loop.keys / Number(ROUND.conns)))); // per connection
      const q = new URLSearchParams({ ...ROUND, keys, db: loop.db, prefix: loop.prefix });

      if (loop.round % 4) q.set("op", "get");
      await runTest("throughput", this.env, q);
    } catch {
      next += RETRY_MS;
    }

    if ((await this.#loop())?.id !== loop.id) return; // stop(), or a new loop(), ran meanwhile
    await this.ctx.storage.put("loop", { ...loop, round: loop.round + 1 });
    await this.#alarms.round(next);
  }

  async #deadline(): Promise<void> {
    await this.ctx.storage.delete("loop");
    await this.#alarms.round.cancel();
  }
}
