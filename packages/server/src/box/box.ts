import { DurableObject } from "cloudflare:workers";
import { flavourOf, serverOf } from "../catalog/flavours";
import { command, concat, error, simple, str } from "../protocol/resp";
import type { CommandArg, Protocol } from "../protocol/types";
import { keepSettings, reapply } from "../settings";
import { droppedStats, isolate, SNAPSHOT_INFO, snapshotOf } from "../shard/stats";
import { DATABASE_DROPPED } from "../shard/tombstone";
import type { DroppedStats, Shard, ShardSnapshot, ShardStats } from "../shard/types";
import { closeWith, messageOf, withTimeout } from "../shared";
import { BOOT_MS, MAXMEMORY } from "./config";
import { replace } from "./container";
import { Engine } from "./engine";
import { proxy } from "./proxy";
import { containerOf } from "./server";
import { BASE, BoxStore, LOG } from "./store";

// The class keeps its first name: renaming it would move every object.
export class RedisBox extends DurableObject<Env> implements Shard {
  readonly #flavour = flavourOf(this.ctx.id.name ?? "");
  readonly #store: BoxStore;
  readonly #instance = crypto.randomUUID();
  readonly #bornAt = Date.now();
  #engine: Promise<Engine> | null = null;
  #running: Engine | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new BoxStore(ctx.storage);
  }

  #ready(): Promise<Engine> {
    if (this.#store.dropped()) return Promise.reject(new Error(DATABASE_DROPPED));

    this.#engine ??= withTimeout(
      Engine.boot(this.ctx, this.#store, serverOf(this.#flavour), this.env.BOX_MAXMEMORY || MAXMEMORY, () => {
        this.#engine = null;
        this.#running = null;
      }),
      BOOT_MS,
      "boot",
    ).then(
      async (engine) => {
        await reapply(this.ctx.storage.sql, (bytes) => engine.mux(2, false).exec(bytes, 1));

        return (this.#running = engine);
      },
      async (e: Error) => {
        console.log(`boot failed: ${e.message}`);
        // A half-booted container holds no acknowledged write this object lacks.
        await replace(this.ctx, "boot failed");
        this.#engine = null;
        throw e;
      },
    );

    return this.#engine;
  }

  override async connect(socket: Socket): Promise<void> {
    let engine: Engine;

    try {
      engine = await this.#ready();
    } catch (e) {
      return await closeWith(socket, messageOf(e) === DATABASE_DROPPED ? error(DATABASE_DROPPED) : null);
    }

    engine.clients++;

    try {
      await proxy(socket, engine.socket(), engine.fence, simple(this.#instance));
    } finally {
      engine.clients--;
    }
  }

  async execRaw(bytes: Uint8Array, count: number, proto: Protocol = 2): Promise<Uint8Array> {
    return await (await this.#ready()).mux(proto).exec(bytes, count);
  }

  async runRaw(cmds: CommandArg[][]): Promise<Uint8Array> {
    const reply = await this.execRaw(concat(cmds.map(command)), cmds.length);

    keepSettings(this.ctx.storage.sql, cmds, reply);

    return reply;
  }

  instance(): string {
    return this.#instance;
  }

  // Doesn't wake a sleeping shard, and isn't client activity: a database the dashboard only watches still sleeps.
  async snapshot(): Promise<ShardSnapshot> {
    const engine = this.#running;
    const info = engine && !engine.closed ? str(await engine.mux(2, false).exec(command(SNAPSHOT_INFO), 1)) : "";

    return snapshotOf(this.#stats(), info);
  }

  stats(): ShardStats | DroppedStats {
    return this.#store.dropped() ? droppedStats(this.#instance) : this.#stats();
  }

  // A wasm shard's shape, its wasm-only fields empty.
  #stats(): ShardStats {
    const gen = this.#store.current()?.gen ?? 0,
      compaction = this.#running?.lastCompaction ?? null;

    return {
      wasmMemoryBytes: 0,
      sockets: this.#running?.clients ?? 0,
      pooled: 0,
      cronRunning: true,
      vfs: {
        writes: 0,
        writeBytes: this.#store.bytes(gen, BASE) + this.#store.bytes(gen, LOG),
        reads: 0,
        readBytes: 0,
        rowsWritten: 0,
      },
      flavour: this.#flavour,
      instance: this.#instance,
      version: this.env.VERSION.id,
      isolate: isolate(),
      colo: null,
      aliveSeconds: (Date.now() - this.#bornAt) / 1000,
      restarting: false,
      lastUpgrade: null,
      role: "primary",
      replicas: [],
      lastRewrite: compaction && { ...compaction, doneMs: null },
      files: [],
    };
  }

  // Tests: "kill" also destroys the container; "container" destroys only it, for this object to restore.
  async abort(reason = "test abort"): Promise<void> {
    if (reason === "kill" || reason === "container") await containerOf(this.ctx).destroy(`test ${reason}`);

    if (reason === "container") return;
    await this.ctx.storage.sync();
    this.ctx.abort(reason);
  }

  async drop(): Promise<void> {
    this.#store.drop();
    this.#running?.shutdown("dropped");

    await replace(this.ctx, "dropped");
  }

  async waitReplicas(_n: number, _ms: number): Promise<number> {
    return 0;
  }
}
