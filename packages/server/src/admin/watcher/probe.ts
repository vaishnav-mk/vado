// A reader and a writer kept open between polls, so each sample is a request, and the reader reads where clients would.
import type { RespClient } from "../../protocol/resp-client";
import { openLocal } from "../../router/local";
import { PROBE_KEY, PROBE_STALL_MS, WATCH_RATE_POLLS } from "../config";
import { keep, type ProbeSample } from "./state";
import { failure } from "../../shared";

async function timed(c: RespClient, argv: string[]): Promise<number> {
  const t = performance.now();
  const [r] = await c.call(argv);
  const err = failure(r);

  if (err !== null) throw new Error(err);

  return performance.now() - t;
}

export class Prober {
  readonly samples: ProbeSample[] = [];
  #reader: RespClient | null = null;
  #writer: RespClient | null = null;

  // An anonymous viewer must not write to the database.
  async probe(env: Env, db: string, writes: boolean): Promise<void> {
    if (!writes && this.#writer) {
      this.#writer.close();
      this.#writer = null;
    }

    try {
      const reader = (this.#reader ??= await this.#open(env, db, ["GET", PROBE_KEY]));
      const writer = writes ? (this.#writer ??= await this.#open(env, db, ["SET", PROBE_KEY, "0"])) : null;

      const [readMs, writeMs] = await Promise.all([
        timed(reader, ["GET", PROBE_KEY]),
        writer && timed(writer, ["SET", PROBE_KEY, String(Date.now())]),
      ]);

      keep(this.samples, { readMs, writeMs }, WATCH_RATE_POLLS);
    } catch {
      this.close();
      keep(this.samples, { failed: true }, WATCH_RATE_POLLS);
    }
  }

  get writes(): boolean {
    return this.#writer !== null;
  }

  close(): void {
    this.#reader?.close();
    this.#writer?.close();
    this.#reader = this.#writer = null;
  }

  stop(): void {
    this.close();
    this.samples.length = 0;
  }

  // The first call warms the path to the key's shard, so it isn't timed.
  async #open(env: Env, db: string, warm: string[]): Promise<RespClient> {
    const c = await openLocal(env, db, PROBE_STALL_MS);
    await timed(c, warm).catch((e: Error) => {
      c.close();
      throw e;
    });

    return c;
  }
}
