// Read replicas of one primary shard. Valkey's AOF already is a replication stream: every write, as the commands
// that redo it. So a replica is sent the AOF files as a starting copy, then every append as it happens, over one
// socket per replica. Replicas keep their data in memory only; one that resets starts empty and is copied again.
import { drizzle } from "drizzle-orm/durable-sqlite";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { Hint } from "../catalog/types";
import { command } from "../protocol/resp";
import { aofFiles } from "./aof-files";
import { REPL_COPY_MS, REPL_IDLE_MS, REPL_STUCK_MS, REPL_TICK_MS } from "./config";
import { ReplicaLink } from "./link";
import { replicaOf } from "./names";
import { replAsleep, replTargets } from "./schema";
import type { ReplicaStatus, ReplicatorHost, ReplicatorShard } from "./types";
import { COPY_CHUNK, MARK, START } from "./wire";
import { messageOf } from "../shared";

const RDB_PREAMBLE_OFF = command(["CONFIG", "SET", "aof-use-rdb-preamble", "no"]);
const RDB_PREAMBLE_ON = command(["CONFIG", "SET", "aof-use-rdb-preamble", "yes"]);
const REWRITE = command(["BGREWRITEAOF"]);

export class Replicator {
  /** Copies are done: the next quiet moment should rewrite the base back to RDB. */
  rdbDue = false;
  #db: DrizzleSqliteDODatabase;
  #host: ReplicatorHost;
  #shard: ReplicatorShard;
  #links = new Map<Hint, ReplicaLink>();
  #copying = 0;
  #lastAppend = Date.now();
  // Idle: replicas retired, no ticks; activity or a write wakes it. Stored, in repl_asleep.
  #asleep: boolean;
  // The rewrite to a command base that copies starting now wait for.
  #basing: Promise<void> | null = null;

  constructor(storage: DurableObjectStorage, host: ReplicatorHost, shard: ReplicatorShard) {
    this.#db = drizzle(storage);
    this.#host = host;
    this.#shard = shard;

    for (const { region } of this.#db.select().from(replTargets).all()) this.#links.set(region, this.#link(region));
    // A sleeping primary is soon evicted, and whatever boots it next (a look from the dashboard, say) must not copy
    // every replica again: only activity wakes it.
    this.#asleep = this.#db.select().from(replAsleep).limit(1).all().length > 0;

    if (this.#links.size && !this.#asleep) shard.schedule(Date.now() + 100);
  }

  get configured(): boolean {
    return this.#links.size > 0;
  }

  get copying(): boolean {
    return this.#copying > 0;
  }

  /** Sets the regions this shard keeps replicas in, remembered across restarts. */
  configure(regions: Hint[]): void {
    this.#db.delete(replTargets).run();

    for (const region of regions) this.#db.insert(replTargets).values({ region }).run();

    for (const [region, link] of this.#links) {
      if (!regions.includes(region)) {
        link.drop("no longer configured");
        this.#links.delete(region);
      }
    }

    for (const region of regions) if (!this.#links.has(region)) this.#links.set(region, this.#link(region));
    // Configuring (re)starts the replicas.
    this.wake();
    this.#shard.schedule(Date.now());
  }

  /** The database is being dropped: every replica stops serving, and nothing copies again. */
  async retireAll(): Promise<void> {
    const regions = [...this.#links.keys()];
    this.#asleep = true;

    for (const link of this.#links.values()) link.drop("dropped");
    this.#links.clear();
    await Promise.all(
      regions.map((r) =>
        replicaOf(this.#shard.replicas, this.#shard.name, r)
          .retire()
          .catch(() => {}),
      ),
    );
  }

  /** Client activity on the primary: if replication went to sleep, start copying again. */
  wake(): void {
    if (!this.#asleep) return;
    this.#asleep = false;
    this.#db.delete(replAsleep).run();

    for (const link of this.#links.values()) link.retryAt = 0;
    this.#shard.schedule(Date.now());
  }

  /** Starts copies for replicas that need one and measures the others, then schedules the next tick. Copies run on
   *  after it returns, so one slow copy doesn't hold up the others' markers or the next tick. */
  async tick(): Promise<void> {
    const now = Date.now();

    if (this.#asleep || (this.#links.size && (await this.#sleepIfIdle(now)))) return;

    for (const link of this.#links.values()) {
      if (link.phase === "idle" && now >= link.retryAt)
        this.#copy(link).catch((e) => link.log(`copy: ${messageOf(e)}`));
      else if (link.phase === "copying" && now - link.since > REPL_COPY_MS) link.drop("the copy took too long");
      else if (link.phase === "live") {
        if (link.marks.length && now - link.marks[0].at > REPL_STUCK_MS) link.drop("stopped answering");
        else if (!link.marks.length) link.mark({ at: now });
      }
    }

    if (this.#links.size) this.#shard.schedule(Date.now() + REPL_TICK_MS);
  }

  /** How many replicas have applied every append so far: a marker goes behind everything already sent to each live
   *  replica, and this resolves once `n` have answered, or after `ms` (0: REPL_STUCK_MS). A replica that is copying,
   *  or about to (waking from sleep, say), gets its marker once it is live: its copy has every append. */
  wait(n: number, ms: number): Promise<number> {
    if (n <= 0 || !this.#links.size) return Promise.resolve(0);
    const { promise, resolve } = Promise.withResolvers<number>();
    let acked = 0;
    const timer = setTimeout(() => resolve(acked), ms > 0 ? ms : REPL_STUCK_MS);

    const onAck = () => {
      if (++acked < n) return;
      clearTimeout(timer);
      resolve(acked);
    };

    for (const link of this.#links.values()) {
      if (link.phase === "live") link.mark({ at: Date.now(), onAck });
      else link.waiting.push(onAck);
    }

    return promise;
  }

  status(): ReplicaStatus[] {
    return [...this.#links.values()].map((link) => link.status(this.#asleep));
  }

  /** Every append to the AOF's incr file, in order: the stream each replica is sent. */
  append(bytes: Uint8Array): void {
    this.#lastAppend = Date.now();
    this.wake();

    for (const link of this.#links.values()) {
      if (link.phase === "copying") link.enqueue(bytes);
      else if (link.phase === "live") link.send(bytes);
    }
  }

  #link(region: Hint): ReplicaLink {
    return new ReplicaLink(region, this.#host, this.#shard.name);
  }

  // Nothing has happened on the primary or its replicas for REPL_IDLE_MS: retire the replicas and stop ticking, so
  // the whole database can be evicted instead of waking every REPL_TICK_MS forever.
  async #sleepIfIdle(now: number): Promise<boolean> {
    const links = [...this.#links.values()];

    if (now - this.#lastAppend < REPL_IDLE_MS || now - this.#host.lastActive < REPL_IDLE_MS) return false;

    if (!links.every((l) => l.phase === "live" && l.ready && !l.inflight)) return false;

    const idle = await Promise.all(
      links.map((l) => (l.stub ? l.stub.replicaIdleMs().catch(() => 0) : Promise.resolve(0))),
    );

    if (!idle.every((ms) => ms >= REPL_IDLE_MS) || this.#lastAppend > now || this.#host.lastActive > now) return false;
    this.#asleep = true;
    this.#db.insert(replAsleep).values({ since: now }).run();

    for (const link of links) link.drop("asleep: idle");

    return true;
  }

  // Commands, not RDB, in the base file (a replica runs the files as commands), and no rewrite while a copy runs:
  // the files only grow. Once no copy runs the base goes back to RDB, ~6x smaller, so each later rewrite (one commit
  // that holds every reply) blocks the shard ~6x less. Shared: copies to every replica start together, and one
  // rewrite serves them all.
  #commandBase(): Promise<void> {
    this.#basing ??= (async () => {
      await this.#host.execBatch(RDB_PREAMBLE_OFF, 1);
      // A rewrite that is running would replace the files mid-copy.
      await this.#host.rewriting;

      if (aofFiles(this.#host).base?.endsWith(".rdb")) {
        await this.#host.execBatch(REWRITE, 1);
        await this.#host.rewriting;
      }
    })().finally(() => {
      this.#basing = null;
    });

    return this.#basing;
  }

  async #copy(link: ReplicaLink): Promise<void> {
    link.startCopy();
    this.#copying++;

    try {
      await this.#commandBase();

      if (link.phase !== "copying") return;
      const { base, incrs } = aofFiles(this.#host);

      if (base?.endsWith(".rdb")) throw new Error("the base is still RDB (its rewrite failed)");
      // Sizes now, synchronously: appends from here on are queued for this replica.
      const parts: [string, number][] = (base ? [base, ...incrs] : incrs).map((p) => [p, this.#host.fileSize(p) ?? 0]);
      link.discardQueue();
      const writer = link.open(replicaOf(this.#shard.replicas, this.#shard.name, link.region), this.#shard.dial);
      await writer.write(START);

      for (const [path, size] of parts)
        for (let pos = 0; pos < size && link.phase === "copying"; pos += COPY_CHUNK)
          await writer.write(this.#chunk(path, pos, Math.min(COPY_CHUNK, size - pos)));
      link.marks.push({ at: Date.now(), ready: true });
      await writer.write(MARK);

      for (let bytes = link.nextQueued(); bytes; bytes = link.nextQueued()) await writer.write(bytes);

      if (link.phase === "copying") link.goLive();
    } catch (e) {
      link.drop(messageOf(e));
    } finally {
      if (--this.#copying === 0) {
        await this.#host.execBatch(RDB_PREAMBLE_ON, 1).catch(() => {});
        this.rdbDue = aofFiles(this.#host).base?.endsWith(".aof") ?? false;
      }
    }
  }

  // Never past the size taken when the copy began: bytes appended since are in the queue, and would run twice.
  #chunk(path: string, pos: number, length: number): Uint8Array {
    const bytes = this.#host.readFile(path, pos, length);

    if (!bytes) throw new Error(`${path} is gone`);

    return bytes;
  }
}
