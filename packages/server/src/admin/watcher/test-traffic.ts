// The dashboard's test traffic on one database: Senders in each chosen region, each looping on its own keys until
// TEST_TRAFFIC_MS has passed or stop(). The running test is stored, so a restarted Watcher can still show and stop it.
import * as v from "valibot";
import { current } from "../../catalog/databases";
import { REGION_NAMES, WORLD } from "../../replication/regions";
import { TEST_KEYS_PER_SHARD, TEST_SENDERS, TEST_TRAFFIC_MS } from "../config";
import type { TestLevel, TestView } from "../live-types";
import type { EventLog } from "./events";

const Level = v.picklist(["light", "medium", "heavy"]);

const Stored = v.object({
  level: Level,
  from: v.string(),
  since: v.number(),
  until: v.number(),
  senders: v.array(v.object({ region: v.string(), k: v.number() })),
});

type Test = v.InferOutput<typeof Stored>;

const inWorld = (region: string) => WORLD.find((r) => r === region);

export class TestTraffic {
  #storage: DurableObjectStorage;
  #env: Env;
  #db: string;
  #log: EventLog;
  #test: Test | null = null;
  #loaded = false;

  constructor(storage: DurableObjectStorage, env: Env, db: string, log: EventLog) {
    this.#storage = storage;
    this.#env = env;
    this.#db = db;
    this.#log = log;
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    const stored: unknown = await this.#storage.get("test");
    this.#test ??= v.is(Stored, stored) ? stored : null;
    this.#loaded = true;
  }

  view(): TestView | null {
    const t = this.#test;

    return t && { level: t.level, from: t.from, since: t.since, until: t.until, senders: t.senders.length };
  }

  async start(level: TestLevel, from: string): Promise<TestView> {
    if (!v.is(Level, level)) throw new Error("level is light, medium or heavy");
    const regions = from === "everywhere" ? WORLD : [inWorld(from)].filter((r) => r !== undefined);

    if (!regions.length) throw new Error("from is everywhere or a region");
    await this.stop(false);
    const record = await current(this.#env, this.#db);

    if (!record || record.dropped) throw new Error(`There is no database named ${this.#db}`);

    const since = Date.now(),
      until = since + TEST_TRAFFIC_MS;

    const senders = regions.flatMap((region) => Array.from({ length: TEST_SENDERS[level] }, (_, k) => ({ region, k })));

    // Each sender writes its own keys, so share a budget that grows with the shards: a 1-shard database stays well
    // inside its memory however many senders there are.
    const keys = Math.max(100, Math.floor((record.shards * TEST_KEYS_PER_SHARD) / senders.length));
    this.#test = { level: level, from, since, until, senders };
    await this.#storage.put("test", this.#test);
    await Promise.all(
      senders.map(({ region, k }) => this.#sender(region, k).loop(this.#db, `test-${region}${k}-`, until, keys)),
    );
    this.#log.add({
      level: "info",
      kind: "test",
      text: `Test traffic started: ${level}, from ${from === "everywhere" ? "everywhere" : REGION_NAMES[from]}`,
    });

    return { level: level, from, since, until, senders: senders.length };
  }

  async stop(say = true, why = "Test traffic stopped"): Promise<null> {
    await this.load();
    const t = this.#test;

    if (!t) return null;
    this.#test = null;
    await this.#storage.delete("test");
    await Promise.all(
      t.senders.map(({ region, k }) =>
        this.#sender(region, k)
          .stop()
          .catch(() => {}),
      ),
    );

    if (say) this.#log.add({ level: "info", kind: "test", text: why });

    return null;
  }

  /** Forgets a test past its deadline: its senders stop themselves. */
  async expire(at: number): Promise<void> {
    if (!this.#test || at < this.#test.until) return;
    this.#test = null;
    await this.#storage.delete("test");
    this.#log.add({
      level: "info",
      kind: "test",
      text: `Test traffic stopped after ${TEST_TRAFFIC_MS / 60_000} minutes`,
    });
  }

  // Per database, so a test on one database never takes over another's senders.
  #sender(region: string, k: number) {
    const hint = inWorld(region);

    if (hint === undefined) throw new Error(`${region} isn't a region`);

    return this.#env.SENDER.getByName(`${this.#db}/${region}/${k}`, { locationHint: hint });
  }
}
