// One shard: a Durable Object running valkey.wasm (or redis.wasm, for a Redis database) with its AOF in the object's
// SQLite. Primaries are classes 0-7; class 8 + k holds the read replicas of class k.
import { DurableObject } from "cloudflare:workers";
import { DurabilityScheduler } from "durability";
import { drizzle } from "drizzle-orm/durable-sqlite";
import type { Hint } from "../catalog/types";
import { decodeAll } from "../protocol/decode";
import { command, concat, str } from "../protocol/resp";
import type { CommandArg, Reply } from "../protocol/types";
import { replicaBinding } from "../replication/names";
import { coloOf } from "../replication/regions";
import type { ReplicaNamespace } from "../replication/types";
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

async function closeWith(socket: Socket, text: string | null): Promise<void> {
  const writer = socket.writable.getWriter();

  if (text) await writer.write(new TextEncoder().encode(text)).catch(() => {});
  await writer.close().catch(() => {});
}

export class ValkeyShard extends DurableObject<Env> {
  /** k of ValkeyShard<k>: its binding is SHARD<k>, its rewriter REWRITER<k>. */
  static readonly shardClass: number = 0;
  #scheduler = new DurabilityScheduler({ context: this.ctx });
  #db = drizzle(this.ctx.storage);
  #instance = crypto.randomUUID();
  #bornAt = Date.now();
  #colo: string | null | undefined; // where this object runs, learned on the first stats() (null until then)
  #shard: LiveShard | null = null; // null: dropped. Storage is gone but the tombstone, and nothing boots

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    if (isDropped(ctx.storage.sql)) return;

    const shardClass = new.target.shardClass;

    const replicas: ReplicaNamespace = {
      getByName: (name, options) => env[replicaBinding(shardClass)].getByName(name, options),
    };

    this.#shard = bootShard(ctx, env, this.#db, this.#scheduler, shardClass, replicas);
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

  // Client activity: wakes a primary's replication if it went to sleep.
  #active(shard: LiveShard): void {
    shard.host.lastActive = Date.now();
    shard.primary?.repl.wake();
    shard.upgrader.checkVersion();
  }

  // RPCs that run commands: refused while restarting (the router tries again on the next instance), and counted,
  // so the restart waits for the ones already running.
  async #rpc<T>(run: (shard: LiveShard) => Promise<T>): Promise<T> {
    const shard = this.#live();

    if (shard.upgrader.restarting) throw new Error(RESTARTING);
    this.#active(shard);

    return await shard.upgrader.running(() => run(shard));
  }

  /** Primary: keep read replicas in these regions (Durable Object location hints). */
  replicate(regions: Hint[]): void {
    this.#primary("a replica can't have replicas").repl.configure(regions);
  }

  /** Drops this shard for good: retires its replicas, deletes its storage, and leaves a tombstone so it never boots
   *  again (a router that still knows the database gets errors, not an empty shard). */
  async drop(): Promise<void> {
    const shard = this.#shard;

    if (!shard) return;
    this.#shard = null; // entry points refuse from here
    await shard.primary?.stop();
    await bury(this.ctx.storage, this.#db);
    void resetSoon(this.ctx, "dropped"); // Valkey still holds the data in memory
  }

  /** Primary: how many replicas have every write made so far (WAIT): once `n` do, or after `ms`. */
  async waitReplicas(n: number, ms: number): Promise<number> {
    return await this.#primary("a replica has no replicas").repl.wait(n, ms);
  }

  /** Replica: ms since a client last read it (the primary's stream doesn't count). */
  replicaIdleMs(): number {
    return Date.now() - this.#live().host.lastActive;
  }

  /** Replica: its primary has stopped streaming to it, so its data only gets older: stop serving, and reset, which
   *  also closes routers' open sockets (their reads go to the primary). The primary copies it again later. */
  retire(): void {
    const replica = this.#shard?.replica;

    if (replica) replica.ready = false;
    void resetSoon(this.ctx, "retired by its primary");
  }

  /** Replica: its primary's copy has arrived; serve reads. Returns where this replica runs. */
  async replicaReady(): Promise<string | null> {
    this.#shard?.replica?.copied();

    return await coloOf().catch(() => null);
  }

  // TCP: one connection is one Valkey client. Routers dial "router-<ms>:6379" (or the old "router:6379") and get this
  // instance's id as the first frame, so they know which instance accepted the socket.
  override async connect(socket: Socket): Promise<void> {
    const address = (await socket.opened).localAddress ?? "";
    const shard = this.#shard;

    if (!shard) return await closeWith(socket, "-ERR database dropped\r\n");

    if (shard.replica) {
      if (address.startsWith("repl")) return await shard.replica.stream(socket, address);

      if (!shard.replica.ready) return await socket.close(); // the router reads from the primary instead
    }

    const greeting = address.startsWith("router") ? `+${this.#instance}\r\n` : null;
    const caller = dialedFrom(address, "router");
    const marker = caller === null ? null : `+${this.#instance}\r\n`; // the greeting again: nothing unanswered ran

    if (caller === null) shard.upgrader.checkVersion();
    else shard.upgrader.upgradeTo(caller).catch((e: Error) => console.log(`upgrade: ${e.stack}`));

    // Set at once by upgradeTo: nothing runs here any more, so greet and say goodbye.
    if (shard.upgrader.restarting) return await closeWith(socket, marker && marker + marker);
    shard.primary?.repl.wake();
    await shard.host.serve(socket, greeting, false, marker);
  }

  /** Runs commands on a pooled internal client and returns the decoded (RESP2) replies. For fan-out and admin. */
  async run(cmds: CommandArg[][]): Promise<Reply[]> {
    return await this.#rpc(async ({ host }) => decodeAll(await host.execBatch(concat(cmds.map(command)), cmds.length)));
  }

  /** The router's RPC mode: `count` raw RESP requests in, their raw replies out (pooled client). */
  async execRaw(bytes: Uint8Array, count: number, proto: 2 | 3 = 2): Promise<Uint8Array> {
    const { replica } = this.#live();

    if (replica && !replica.ready) throw new Error("replica not ready");

    return await this.#rpc(({ host }) => host.execBatch(bytes, count, proto));
  }

  /** Like run, but returns the raw reply bytes. */
  async runRaw(cmds: CommandArg[][]): Promise<Uint8Array> {
    return await this.#rpc(({ host }) => host.execBatch(concat(cmds.map(command)), cmds.length));
  }

  /** Identifies this in-memory instance; a reset, eviction or isolate move gives a new one. */
  instance(): string {
    return this.#instance;
  }

  /** Test hook: how long this object's storage takes to confirm a write (what every reply waits for). */
  async commitProbe(n = 20): Promise<{ colo: string | null | undefined; ms: number[] }> {
    this.#live();

    return { colo: this.#colo, ms: await commitTimes(this.ctx.storage, this.#db, n) };
  }

  /** Test hook: storage commit times for writing two `mb` MB files, then deleting them. */
  async vfsProbe(mb = 32): Promise<VfsProbe> {
    return await vfsTimes(this.ctx.storage, this.#db, this.#live().host, mb);
  }

  /** Test hook: hard-reset this object (as a crash or deploy would). */
  async abort(reason = "test abort"): Promise<void> {
    await this.ctx.storage.sync();
    this.ctx.abort(reason);
  }

  /** stats() plus Valkey's own INFO counters, in one call. Not client activity: a database that is only watched
   *  (the dashboard polls every shard) still goes to sleep. */
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
      void coloOf().then(
        (colo) => {
          this.#colo = colo;
        },
        () => {},
      );
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
