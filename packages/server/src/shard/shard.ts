import { DurableObject } from "cloudflare:workers";
import { DurabilityScheduler } from "durability";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { replicaNamespace } from "../catalog/placement";
import type { Hint } from "../catalog/types";
import { decodeAll } from "../protocol/decode";
import { command, concat, str } from "../protocol/resp";
import type { CommandArg, Reply } from "../protocol/types";
import { coloOf } from "../replication/regions";
import { keepSettings } from "../settings";
import { bootShard } from "./boot";
import type { LiveShard } from "./boot";
import type { PrimaryRole } from "./primary";
import { commitTimes, vfsTimes } from "./probes";
import type { VfsProbe } from "./probes";
import { resetSoon } from "./reset";
import { droppedStats, isolate, SNAPSHOT_INFO, snapshotOf } from "./stats";
import { bury, isDropped } from "./tombstone";
import type { DroppedStats, ShardSnapshot, ShardStats } from "./types";
import { dialedFrom, RESTARTING } from "./version";
import { closeWith, encoder, noop } from "../shared";

export class ValkeyShard extends DurableObject<Env> {
  static readonly shardClass: number = 0;
  #scheduler = new DurabilityScheduler({ context: this.ctx });
  #db = drizzle(this.ctx.storage);
  #instance = crypto.randomUUID();
  #bornAt = Date.now();
  #colo: string | null | undefined; // undefined until the first stats() asks
  #shard: LiveShard | null = null; // null: dropped

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    if (isDropped(ctx.storage.sql)) return;

    const shardClass = new.target.shardClass;
    this.#shard = bootShard(ctx, env, this.#db, this.#scheduler, shardClass, replicaNamespace(env, shardClass));
  }

  override alarm(info?: AlarmInvocationInfo): Promise<void> {
    return this.#scheduler.alarm(info);
  }

  #live(): LiveShard {
    if (!this.#shard) throw new Error("ERR database dropped");

    return this.#shard;
  }

  #primary(refusal: string): PrimaryRole {
    const { primary } = this.#live();

    if (!primary) throw new Error(refusal);

    return primary;
  }

  #active(shard: LiveShard): void {
    shard.host.lastActive = Date.now();
    shard.primary?.repl.wake();
    shard.upgrader.checkVersion();
  }

  // The router retries a refused RPC on the next instance; a restart waits for the ones running.
  async #rpc<T>(run: (shard: LiveShard) => Promise<T>): Promise<T> {
    const shard = this.#live();

    if (shard.upgrader.restarting) throw new Error(RESTARTING);
    this.#active(shard);

    return await shard.upgrader.running(() => run(shard));
  }

  replicate(regions: Hint[]): void {
    this.#primary("a replica can't have replicas").repl.configure(regions);
  }

  async drop(): Promise<void> {
    const shard = this.#shard;

    if (!shard) return;
    this.#shard = null;

    try {
      await shard.primary?.stop();
      await bury(this.ctx.storage, this.#db);
    } finally {
      void resetSoon(this.ctx, "dropped"); // Valkey still holds the data in memory
    }
  }

  async waitReplicas(n: number, ms: number): Promise<number> {
    return await this.#primary("a replica has no replicas").repl.wait(n, ms);
  }

  replicaIdleMs(): number {
    return Date.now() - this.#live().host.lastActive;
  }

  // The reset also closes routers' open sockets, so their reads go to the primary.
  retire(): void {
    const replica = this.#shard?.replica;

    if (replica) replica.ready = false;
    void resetSoon(this.ctx, "retired by its primary");
  }

  async replicaReady(): Promise<string | null> {
    this.#shard?.replica?.copied();

    return await coloOf().catch(() => null);
  }

  override async connect(socket: Socket): Promise<void> {
    const address = (await socket.opened).localAddress ?? "";
    const shard = this.#shard;

    if (!shard) return await closeWith(socket, encoder.encode("-ERR database dropped\r\n"));

    if (shard.replica) {
      if (address.startsWith("repl")) return await shard.replica.stream(socket, address);

      if (!shard.replica.ready) return await socket.close(); // the router reads from the primary instead
    }

    const greeting = address.startsWith("router") ? `+${this.#instance}\r\n` : null;
    const caller = dialedFrom(address, "router");
    const marker = caller === null ? null : `+${this.#instance}\r\n`;

    if (caller === null) shard.upgrader.checkVersion();
    else shard.upgrader.upgradeTo(caller).catch((e: Error) => console.log(`upgrade: ${e.stack}`));

    // upgradeTo sets it synchronously.
    if (shard.upgrader.restarting) return await closeWith(socket, marker ? encoder.encode(marker + marker) : null);
    shard.primary?.repl.wake();
    await shard.host.serve(socket, greeting, false, marker);
  }

  async run(cmds: CommandArg[][]): Promise<Reply[]> {
    return decodeAll(await this.runRaw(cmds));
  }

  async execRaw(bytes: Uint8Array, count: number, proto: 2 | 3 = 2): Promise<Uint8Array> {
    const { replica } = this.#live();

    if (replica && !replica.ready) throw new Error("replica not ready");

    return await this.#rpc(({ host }) => host.execBatch(bytes, count, proto));
  }

  async runRaw(cmds: CommandArg[][]): Promise<Uint8Array> {
    const reply = await this.#rpc(({ host }) => host.execBatch(concat(cmds.map(command)), cmds.length));

    keepSettings(this.ctx.storage.sql, cmds, reply);

    return reply;
  }

  instance(): string {
    return this.#instance;
  }

  async commitProbe(n = 20): Promise<{ colo: string | null | undefined; ms: number[] }> {
    this.#live();

    return { colo: this.#colo, ms: await commitTimes(this.ctx.storage, this.#db, n) };
  }

  async vfsProbe(mb = 32): Promise<VfsProbe> {
    return await vfsTimes(this.ctx.storage, this.#db, this.#live().host, mb);
  }

  async abort(reason = "test abort"): Promise<void> {
    await this.ctx.storage.sync();
    this.ctx.abort(reason);
  }

  // Not client activity: a database the dashboard only watches still goes to sleep.
  async snapshot(): Promise<ShardSnapshot> {
    const shard = this.#live();
    const info = await shard.host.execBatch(command(SNAPSHOT_INFO), 1);

    return snapshotOf(this.#stats(shard), str(info));
  }

  stats(): ShardStats | DroppedStats {
    return this.#shard ? this.#stats(this.#shard) : droppedStats(this.#instance);
  }

  #stats({ host, flavour, upgrader, primary, replica }: LiveShard): ShardStats {
    if (this.#colo === undefined) {
      this.#colo = null;
      void coloOf().then((colo) => {
        this.#colo = colo;
      }, noop);
    }

    const last = primary?.rewrites.last;

    return {
      ...host.stats(),
      flavour,
      instance: this.#instance,
      version: this.env.VERSION.id,
      isolate: isolate(),
      colo: this.#colo,
      aliveSeconds: (Date.now() - this.#bornAt) / 1000,
      restarting: upgrader.restarting,
      lastUpgrade: upgrader.lastUpgrade(),
      files: host.files(),
      role: replica ? "replica" : "primary",
      replicas: primary ? primary.repl.status() : [],
      lastRewrite: last ? { ...last, doneMs: host.rewriteDoneMs } : null,
      ready: replica?.ready,
    };
  }
}
