// Runs a bench test from a Durable Object placed in one region, so its connections, and the routers
// serving them, start there: test traffic that enters Cloudflare far from whoever asked for it.
import { DurableObject } from "cloudflare:workers";
import { runTest } from "./bench.js";

export class Sender extends DurableObject {
  async run(params) {
    const q = new URLSearchParams(params);
    return await runTest(q.get("test") ?? "throughput", this.env, q);
  }
}
