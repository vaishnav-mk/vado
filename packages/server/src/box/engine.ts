import type { Server } from "../catalog/types";
import { messageOf, noop, withTimeout } from "../shared";
import { replace, startServer } from "./container";
import { containerOf, dial } from "./server";
import type { Started } from "./container";
import { CANT_CONTINUE, FENCE_MS, ReplicaLink } from "./link";
import type { Resume } from "./link";
import { Mux } from "./mux";
import type { Fence } from "./proxy";
import { BASE, LOG } from "./store";
import type { BoxStore, Generation } from "./store";

const LINK_MS = 300_000;

const TICK_MS = 10_000;

// With no client this long, the shard folds its stream into a fresh base and stops the container, which costs money
// while it runs. The platform stops it too, a little later, if the object was evicted first.
const IDLE_MS = 10 * 60_000;

const FOLD_MS = 5 * 60_000;

// A new generation once the stream is bigger than its base, so storage and restores stay about one base in size.
const COMPACT_MIN = 64 << 20;

// Pre-dialed connections for dedicated clients (transactions, pub/sub, blocking).
const SPARES = 4;

// A server that kept running must go on from the last stored byte, or it may hold a restore cut short. A restored one
// holds exactly what's stored, so it goes on from its own history. The server checks its history, so a wrong guess
// costs a full copy, never a gap.
function resumeOf(store: BoxStore, from: Generation, started: Started): Resume | null {
  if (started.reused) {
    const end = (from.shift ?? from.offset) + store.bytes(from.gen, LOG);

    return { from, replid: from.master ?? from.replid, offset: end, only: true };
  }

  return started.history && { from, ...started.history, only: false };
}

const linkFor = (ctx: DurableObjectState, store: BoxStore, started: Started, onBroken: (why: string) => void) => {
  const current = store.current();

  return openLink(ctx, store, (current?.gen ?? 0) + 1, current && resumeOf(store, current, started), onBroken);
};

// A running container plus the replication link that stores it. Lost for good on shutdown(); the object boots another.
export class Engine {
  link: ReplicaLink;
  closed = false;
  clients = 0;
  readonly #ctx: DurableObjectState;
  readonly #store: BoxStore;
  readonly #onLost: (why: string) => void;
  readonly #spares: Socket[] = [];
  readonly #muxes = new Map<2 | 3, Mux>();
  readonly #tick: ReturnType<typeof setInterval>;
  #lastActive = Date.now();
  #foldedFor = 0; // the #lastActive an idle fold was tried for
  #compacting = false;

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

    if (!this.#compacting && logged > Math.max(COMPACT_MIN, this.#store.bytes(gen, BASE))) void this.#compact();
  }

  // A second replica link takes a fresh RDB while the first keeps storing the stream. It becomes current only once
  // it has stored everything the first has, so no acknowledged write lives only in the generation being dropped.
  async #compact(): Promise<void> {
    this.#compacting = true;

    const t0 = Date.now(),
      old = this.link;

    try {
      const next = await openLink(this.#ctx, this.#store, old.generation.gen + 1, null, (why) => this.shutdown(why));

      await withTimeout(next.caughtUp(old), LINK_MS, "compaction catch-up").catch((e: Error) => {
        next.close();
        throw e;
      });

      if (this.closed || this.link !== old) return next.close();
      this.#store.switchTo(next.generation);
      this.link = next;
      old.handOver(next);
      console.log(
        JSON.stringify({ compacted: Date.now() - t0, baseMB: this.#store.bytes(next.generation.gen, BASE) / 1e6 }),
      );
    } catch (e) {
      console.log(`compaction failed: ${messageOf(e)}`);
    } finally {
      this.#compacting = false;
    }
  }
}

// A sync that outlives its timeout must not keep writing next to the one that replaces it.
async function openLink(
  ctx: DurableObjectState,
  store: BoxStore,
  gen: number,
  resume: Resume | null,
  onBroken: (why: string) => void,
): Promise<ReplicaLink> {
  const socket = dial(ctx);

  await socket.opened;

  return await withTimeout(
    ReplicaLink.open(socket, store, gen, resume, (e) => onBroken(`replication: ${e.message}`)),
    LINK_MS,
    `syncing generation ${gen}`,
  ).catch((e: Error) => {
    socket.close().catch(noop);
    throw e;
  });
}
