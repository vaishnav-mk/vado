// Memory only but for the running test: an eviction just starts the history again.
import { DurableObject } from "cloudflare:workers";
import { DurabilityAlarms } from "durability";
import { DurabilitySocket, event } from "durability/socket";
import * as v from "valibot";
import { existing } from "../../catalog/databases";
import { replicaRegion } from "../../catalog/placement";
import { shardOfSlot, slotOf } from "../../protocol/slots";
import { coloOf } from "../../replication/regions";
import { commands } from "../../router/command-table";
import { encoder, messageOf } from "../../shared";
import { PROBE_KEY, WATCH_HISTORY, WATCH_MS, WATCH_REPLAY } from "../config";
import type { EventKind, LiveSnapshot, LiveState, Point, TestLevel, TestView, Tick } from "../live-types";
import { shardSnapshots } from "../snapshot";
import { dbView, place, shardView } from "../views";
import { Entries } from "./entries";
import { EventLog, summarize } from "./events";
import { Prober } from "./probe";
import { Shards } from "./shards";
import { buildState, keep, point, type Reading } from "./state";
import { TestTraffic } from "./test-traffic";

export const SIGNED_IN = "x-vado-signed-in";

export interface LiveMetadata {
  signedIn: boolean;
}

const Attachment = v.object({ metadata: v.object({ signedIn: v.boolean() }) });

const signedIn = (ws: WebSocket) => {
  const attachment: unknown = ws.deserializeAttachment();

  return v.is(Attachment, attachment) && attachment.metadata.signedIn;
};

export class Watcher extends DurableObject<Env> {
  #name: string;
  #log = new EventLog();
  #shards = new Shards();
  #entries = new Entries();
  #prober = new Prober();
  #test: TestTraffic;
  #state: LiveState | null = null;
  #history: Point[] = [];
  #polling = false; // a poll is scheduled or running

  readonly #alarms = new DurabilityAlarms({
    context: this.ctx,
    alarmMinDelayMs: WATCH_MS,
    handlers: { poll: () => this.#poll() },
    methods: { poll: { retries: { maxAttempts: 1 } } }, // #poll schedules the next one even if this one fails
  });

  readonly socket = new DurabilitySocket({
    context: this.ctx,
    retention: WATCH_REPLAY,
    inbound: {
      snapshot: {
        input: v.undefined(),
        handle: (): LiveSnapshot => ({ history: this.#history, events: this.#log.events, state: this.#state }),
      },
    },
    outbound: { tick: event<Tick>() },
    metadata: (req): LiveMetadata => ({ signedIn: req.headers.get(SIGNED_IN) === "1" }),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    if (ctx.id.name === undefined) throw new Error("a Watcher is named by its database (getByName)");
    this.#name = ctx.id.name;
    this.#test = new TestTraffic(ctx.storage, env, this.#name, this.#log);
  }

  override async fetch(req: Request): Promise<Response> {
    const res = await this.socket.fetch(req);

    if (res.status === 101 && !this.#polling) {
      this.#polling = true;
      await this.#alarms.poll(Date.now());
    }

    return res;
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.socket.webSocketMessage(ws, message);
  }

  override webSocketClose(ws: WebSocket): void {
    this.socket.webSocketClose(ws);
  }

  override alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.#alarms.alarm(info);
  }

  note(kind: EventKind, text: string): void {
    this.#log.add({ level: "info", kind, text });
  }

  restarting(i: number): void {
    this.#shards.asked(i);
    this.#log.add({ level: "info", kind: "action", text: `Restarting shard ${i}`, shard: i });
  }

  startTest(level: TestLevel, from: string): Promise<TestView> {
    return this.#test.start(level, from);
  }

  stopTest(say = true, why = "Test traffic stopped"): Promise<null> {
    return this.#test.stop(say, why);
  }

  async #poll(): Promise<void> {
    this.#polling = true;
    const watchers = this.ctx.getWebSockets();

    if (!watchers.length) return await this.#idle();
    const started = Date.now();

    try {
      await this.#test.load();
      await this.#test.expire(started);
      this.#state = buildState(await this.#read(started, watchers.some(signedIn)));
      const latest = point(this.#state);
      keep(this.#history, latest, WATCH_HISTORY);
      this.socket.tick({ point: latest, events: this.#log.fresh(), state: this.#state });
    } finally {
      await this.#alarms.poll(started + WATCH_MS);
    }
  }

  // On an error the page keeps what the last poll saw, marked unreachable.
  async #read(at: number, writes: boolean): Promise<Reading> {
    const last = this.#state;

    const reading: Reading = {
      at,
      error: null,
      db: last?.db ?? null,
      watcher: last?.watcher ?? null,
      shards: last?.shards ?? [],
      entries: last?.map.entries ?? [],
      probes: this.#prober.samples,
      probeAt: null,
      writes,
      test: null,
    };

    try {
      const record = await existing(this.env, this.#name);

      if (!record) throw new Error(`There is no database named ${this.#name}`);
      reading.db = dbView(record);

      const [looks, table, pulse, colo] = await Promise.all([
        shardSnapshots(this.env, record),
        commands(this.env, record.flavour),
        this.env.PULSE.getByName("pulse").snapshot(),
        coloOf().catch(() => null),
        this.#prober.probe(this.env, this.#name, writes),
      ]);

      reading.watcher = place(colo);
      reading.probeAt = {
        shard: shardOfSlot(slotOf(encoder.encode(PROBE_KEY)), record.shards),
        replica: colo ? replicaRegion(record, colo) : null,
      };

      const seen = this.#shards.see(
        looks.map((s, i) => shardView(s, i, table)),
        at,
      );

      for (const e of [...seen.alerts, ...summarize(seen.changes, this.#shards.size)]) this.#log.add(e);
      reading.shards = seen.shards;
      reading.entries = this.#entries.see(pulse.isolates, this.#name);
    } catch (e) {
      reading.error = messageOf(e);
    }

    reading.writes = this.#prober.writes;
    reading.test = this.#test.view();

    return reading;
  }

  async #idle(): Promise<void> {
    this.#polling = false;
    await this.#test.stop(true, "Test traffic stopped: nobody is watching");
    this.#prober.stop();
    this.#shards.clear();
    this.#entries.clear();
  }
}
