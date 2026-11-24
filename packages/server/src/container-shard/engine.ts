import type { Server } from "../catalog/types";
import type { Protocol } from "../protocol/types";
import type { RewriteLog } from "../shard/types";
import { messageOf, noop, sleep, withTimeout } from "../shared";
import { linkFor, openLink } from "./attach";
import { COMPACT_MIN, FENCE_MS, FOLD_MS, IDLE_MS, LINK_MS, PRUNE_BYTES, PRUNE_GAP_MS, SPARES, TICK_MS } from "./config";
import { replace, startServer } from "./container";
import { CANT_CONTINUE } from "./link";
import type { StreamLink } from "./link";
import { Mux } from "./mux";
import { containerOf, dial } from "./server";
import { BASE, LOG } from "./store";
import type { BoxStore } from "./store";
import type { Fence } from "./types";

// Lost for good on shutdown(); the object boots another.
export class Engine {
  link: StreamLink;
  closed = false;
  clients = 0;
  lastCompaction: RewriteLog | null = null;
  readonly #ctx: DurableObjectState;
  readonly #store: BoxStore;
  readonly #onLost: (why: string) => void;
  readonly #spares: Socket[] = [];
  readonly #muxes = new Map<Protocol, Mux>();
  readonly #tick: ReturnType<typeof setInterval>;
  #lastActive = Date.now();
  #foldedFor = 0; // the #lastActive an idle fold was tried for
  #compacting = false;
  #pruning = false;

  private constructor(ctx: DurableObjectState, store: BoxStore, link: StreamLink, onLost: (why: string) => void) {
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

  socket(): Socket {
    this.#lastActive = Date.now();
    const socket = this.#spares.pop() ?? dial(this.#ctx);

    this.#refill();

    return socket;
  }

  // RPC batches share one pipelined connection; the dashboard's polls pass active=false.
  mux(proto: Protocol, active = true): Mux {
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
      // Fold first: a bare base wakes fastest, with no replay.
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

  // The new generation becomes current only once it holds everything the old one does.
  async #compact(): Promise<void> {
    this.#compacting = true;

    const t0 = Date.now(),
      old = this.link;

    try {
      const next = await openLink(this.#ctx, this.#store, this.#store.begin(), null, (why) => this.shutdown(why));
      const sentMs = Date.now() - t0; // until the RDB is stored

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
