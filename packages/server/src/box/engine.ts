import type { RewriteLog } from "../shard/types";
import type { Server } from "../catalog/types";
import { messageOf, noop, sleep, withTimeout } from "../shared";
import { LINK_MS, linkFor, openLink } from "./attach";
import { replace, startServer } from "./container";
import { containerOf, dial } from "./server";
import { CANT_CONTINUE, FENCE_MS } from "./link";
import type { ReplicaLink } from "./link";
import { Mux } from "./mux";
import type { Fence } from "./proxy";
import { BASE, LOG } from "./store";
import type { BoxStore } from "./store";

const TICK_MS = 10_000;

// With no client this long, the shard folds its stream into a fresh base and stops the container, which costs money
// while it runs. The platform stops it too, a little later, if the object was evicted first.
const IDLE_MS = 10 * 60_000;

const FOLD_MS = 5 * 60_000;

// A new generation once the stream is bigger than its base, so storage and restores stay about one base in size.
const COMPACT_MIN = 64 << 20;

// A delete runs on this object's one thread and holds every reply until it commits: 8 MB at a time, with a gap after.
const PRUNE_BYTES = 8 << 20;

const PRUNE_GAP_MS = 250;

// Pre-dialed connections for dedicated clients (transactions, pub/sub, blocking).
const SPARES = 4;

// A running container plus the replication link that stores it. Lost for good on shutdown(); the object boots another.
export class Engine {
  link: ReplicaLink;
  closed = false;
  clients = 0;
  lastCompaction: RewriteLog | null = null; // the box's stats report it as its last rewrite
  readonly #ctx: DurableObjectState;
  readonly #store: BoxStore;
  readonly #onLost: (why: string) => void;
  readonly #spares: Socket[] = [];
  readonly #muxes = new Map<2 | 3, Mux>();
  readonly #tick: ReturnType<typeof setInterval>;
  #lastActive = Date.now();
  #foldedFor = 0; // the #lastActive an idle fold was tried for
  #compacting = false;
  #pruning = false;

  private constructor(ctx: DurableObjectState, store: BoxStore, link: ReplicaLink, onLost: (why: string) => void) {
    this.#ctx = ctx;
    this.#store = store;
    this.link = link;
    this.#onLost = onLost;
    this.#tick = setInterval(() => this.#check(), TICK_MS);
    this.#refill();
  }

  static async boot(
    ctx: DurableObjectState,
    store: BoxStore,
    server: Server,
    maxmemory: string,
    onLost: (why: string) => void,
  ): Promise<Engine> {
    const t0 = Date.now();
    let started = await startServer(ctx, store, server, maxmemory);
    const t1 = Date.now();
    let booted: Engine | null = null;
    const onBroken = (why: string) => booted?.shutdown(why);

    const link = await linkFor(ctx, store, started, onBroken).catch(async (e: Error) => {
      if (e.message !== CANT_CONTINUE) throw e;
      await replace(ctx, CANT_CONTINUE);
      started = await startServer(ctx, store, server, maxmemory);

      return await linkFor(ctx, store, started, onBroken);
    });

    store.switchTo(link.generation);
    await containerOf(ctx).setInactivityTimeout(IDLE_MS + FOLD_MS);
    const engine = new Engine(ctx, store, link, onLost);

    booted = engine;
    void engine.#prune();
    void started.exited
      .catch((e: Error) => console.log(`container: ${e.message}`))
      .finally(() => engine.shutdown("stopped"));
    console.log(
      JSON.stringify({
        ready: Date.now() - t0,
        startMs: t1 - t0,
        syncMs: Date.now() - t1,
        reused: started.reused,
        continued: link.continued,
        restored: started.restored,
      }),
    );

    return engine;
  }

  readonly fence: Fence = (offset) => this.link.reached(offset, FENCE_MS);

  // A connection of its own, for a client that needs one.
  socket(): Socket {
    this.#lastActive = Date.now();
    const socket = this.#spares.pop() ?? dial(this.#ctx);

    this.#refill();

    return socket;
  }

  // The shared, pipelined connection for stateless batches. The dashboard's polls aren't client activity.
  mux(proto: 2 | 3, active = true): Mux {
    if (active) this.#lastActive = Date.now();
    let mux = this.#muxes.get(proto);

    if (!mux || mux.broken) {
      mux = new Mux(dial(this.#ctx), this.fence, proto);
      this.#muxes.set(proto, mux);
    }

    return mux;
  }

  shutdown(why: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.#tick);
    this.link.close();

    for (const mux of this.#muxes.values()) mux.close();

    for (const spare of this.#spares) spare.close().catch(noop);
    console.log(`engine down: ${why}`);
    this.#onLost(why);
  }

  #refill(): void {
    while (this.#spares.length < SPARES) {
      const spare = dial(this.#ctx);

      this.#spares.push(spare);
      spare.opened.catch(() => this.#spares.splice(this.#spares.indexOf(spare), 1));
    }
  }

  #check(): void {
    const { gen } = this.link.generation;
    const logged = this.#store.bytes(gen, LOG);

    if (this.clients === 0 && Date.now() - this.#lastActive > IDLE_MS) {
      // A shard wakes fastest from a bare base: no replay, and its server continues the stream. One try per idle spell.
      if (logged > 0 && this.#foldedFor !== this.#lastActive) {
        this.#foldedFor = this.#lastActive;

        if (!this.#compacting) void this.#compact();

        return;
      }

      if (this.#compacting) return;
      this.shutdown("idle");
      void containerOf(this.#ctx).destroy("idle").catch(noop);

      return;
    }

    if (!this.#compacting && !this.#pruning && logged > Math.max(COMPACT_MIN, this.#store.bytes(gen, BASE)))
      void this.#compact();
  }

  // Replaced and abandoned generations, a batch at a time, with client traffic running between.
  async #prune(): Promise<void> {
    if (this.#pruning) return;
    this.#pruning = true;

    try {
      while (!this.closed && this.#store.prune(PRUNE_BYTES)) {
        await this.#store.sync();
        await sleep(PRUNE_GAP_MS);
      }
    } catch (e) {
      console.log(`prune: ${messageOf(e)}`);
    } finally {
      this.#pruning = false;
    }
  }

  // A second replica link takes a fresh RDB while the first keeps storing the stream. It becomes current only once
  // it has stored everything the first has, so no acknowledged write lives only in the generation being dropped.
  async #compact(): Promise<void> {
    this.#compacting = true;

    const t0 = Date.now(),
      old = this.link;

    try {
      const next = await openLink(this.#ctx, this.#store, this.#store.begin(), null, (why) => this.shutdown(why));
      const sentMs = Date.now() - t0; // the copy stored; then the stream since

      await withTimeout(next.caughtUp(old), LINK_MS, "compaction catch-up").catch((e: Error) => {
        next.close();
        throw e;
      });

      if (this.closed || this.link !== old) return next.close();
      this.#store.switchTo(next.generation);
      this.link = next;
      old.handOver(next);
      void this.#prune();
      this.lastCompaction = {
        at: t0,
        rdb: true,
        ms: Date.now() - t0,
        sentMs,
        baseBytes: this.#store.bytes(next.generation.gen, BASE),
      };
    } catch (e) {
      this.lastCompaction = { at: t0, rdb: true, ms: Date.now() - t0, error: messageOf(e) };
    } finally {
      console.log(JSON.stringify({ compaction: this.lastCompaction }));
      this.#compacting = false;
    }
  }
}
