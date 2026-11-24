import { DurableObject } from "cloudflare:workers";
import type { Hint } from "../catalog/types";
import { command, concat, str } from "../protocol/resp";
import type { CommandArg } from "../protocol/types";
import { infoFields } from "../shard/info";
import type { VfsProbe } from "../shard/probes";
import { isolate, SNAPSHOT_INFO } from "../shard/stats";
import type { DroppedStats, ShardSnapshot, ShardStats } from "../shard/types";
import { closeWith, encoder, messageOf, withTimeout } from "../shared";
import { flavourOf, serverOf } from "../catalog/flavours";
import { Engine } from "./engine";
import { proxy } from "./proxy";
import { keepSettings, reapply } from "../settings";
import { replace } from "./container";
import { containerOf } from "./server";
import { boxStats } from "./stats";
import { BASE, BoxStore, LOG } from "./store";

const BOOT_MS = 600_000;
const NOT_HERE = "databases in containers have no read replicas or wasm probes yet";

// One shard of a database in containers: the container runs the server (Valkey or Redis, from the flavour in this
// object's name), and this object stores its replication stream and holds every reply until the writes it depends on
// are stored (engine.ts, link.ts, proxy.ts). The class keeps its first name: renaming it would move every object.
export class RedisBox extends DurableObject<Env> {
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
    if (this.#store.dropped()) return Promise.reject(new Error("ERR database dropped"));

    this.#engine ??= withTimeout(
      Engine.boot(this.ctx, this.#store, serverOf(this.#flavour), this.env.BOX_MAXMEMORY || "2gb", () => this.#lost()),
      BOOT_MS,
      "boot",
    ).then(
      async (engine) => {
        await reapply(this.ctx.storage.sql, (bytes) => engine.mux(2, false).exec(bytes, 1));

        return (this.#running = engine);
      },
      async (e: Error) => {
        console.log(`boot failed: ${e.message}`);
        // A half-booted container holds no acknowledged write this object lacks; the next boot starts clean.
        await replace(this.ctx, "boot failed");
        this.#engine = null;
        throw e;
      },
    );

    return this.#engine;
  }

  // The next caller boots again: a running container is reused, a stopped one restored from storage.
  #lost(): void {
    this.#engine = null;
    this.#running = null;
  }

  override async connect(socket: Socket): Promise<void> {
    let engine: Engine;

    try {
      engine = await this.#ready();
    } catch (e) {
      const dropped = messageOf(e).includes("dropped");

      return await closeWith(socket, dropped ? encoder.encode("-ERR database dropped\r\n") : null);
    }

    engine.clients++;

    try {
      await proxy(socket, engine.socket(), engine.fence, encoder.encode(`+${this.#instance}\r\n`));
    } finally {
      engine.clients--;
    }
  }

  async execRaw(bytes: Uint8Array, count: number, proto: 2 | 3 = 2): Promise<Uint8Array> {
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

    return { ...this.#stats(), info: infoFields(info) };
  }

  stats(): ShardStats | DroppedStats {
    if (this.#store.dropped())
      return { dropped: true, instance: this.#instance, isolate: isolate(), files: [], replicas: [] };

    return { ...this.#stats(), files: [] };
  }

  #stats(): Omit<ShardStats, "files"> {
    const gen = this.#store.current()?.gen ?? 0;

    return boxStats({
      flavour: this.#flavour,
      instance: this.#instance,
      version: this.env.VERSION.id,
      bornAt: this.#bornAt,
      clients: this.#running?.clients ?? 0,
      stored: this.#store.bytes(gen, BASE) + this.#store.bytes(gen, LOG),
      compaction: this.#running?.lastCompaction ?? null,
    });
  }

  // Tests: abort() loses this object's memory and keeps the container; abort("kill") loses the container's too;
  // abort("container") loses only the container's, and this object restores it.
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

  replicate(_regions: Hint[]): void {
    throw new Error(NOT_HERE);
  }

  async waitReplicas(_n: number, _ms: number): Promise<number> {
    return 0;
  }

  replicaIdleMs(): number {
    throw new Error(NOT_HERE);
  }

  retire(): void {
    throw new Error(NOT_HERE);
  }

  async replicaReady(): Promise<string | null> {
    throw new Error(NOT_HERE);
  }

  async commitProbe(_n = 20): Promise<{ colo: string | null | undefined; ms: number[] }> {
    throw new Error(NOT_HERE);
  }

  async vfsProbe(_mb = 32): Promise<VfsProbe> {
    throw new Error(NOT_HERE);
  }
}
