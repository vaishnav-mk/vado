import { messageOf, withTimeout } from "../shared";
import { FENCE_MS, ReplicaLink } from "./link";
import { Mux } from "./mux";
import type { Fence } from "./proxy";
import { containerOf, dial, startRedis } from "./redis";
import { BASE, LOG } from "./store";
import type { BoxStore } from "./store";

const LINK_MS = 300_000;

const TICK_MS = 10_000;

// With no client this long, the container stops (it costs money while running) and the next caller restores from
// storage. The engine stops it itself, and the platform does if the object was evicted first.
const IDLE_MS = 10 * 60_000;

// A new generation once the stream is bigger than its base, so storage and restores stay about one base in size.
const COMPACT_MIN = 64 << 20;

// Pre-dialed connections for dedicated clients (transactions, pub/sub, blocking).
const SPARES = 4;

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
    maxmemory: string,
    onLost: (why: string) => void,
  ): Promise<Engine> {
    const t0 = Date.now();
    const { exited, restored } = await startRedis(ctx, store, maxmemory);

    await containerOf(ctx).setInactivityTimeout(IDLE_MS);
    const t1 = Date.now();
    let booted: Engine | null = null;
    const link = await openLink(ctx, store, (store.current()?.gen ?? 0) + 1, (why) => booted?.shutdown(why));

    store.switchTo(link.generation);
    const engine = new Engine(ctx, store, link, onLost);

    booted = engine;
    void exited.catch((e: Error) => console.log(`container: ${e.message}`)).finally(() => engine.shutdown("stopped"));
    console.log(JSON.stringify({ ready: Date.now() - t0, startMs: t1 - t0, syncMs: Date.now() - t1, restored }));

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

    for (const spare of this.#spares) spare.close().catch(() => null);
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
    if (this.clients === 0 && Date.now() - this.#lastActive > IDLE_MS) {
      this.shutdown("idle");
      void containerOf(this.#ctx)
        .destroy("idle")
        .catch(() => null);

      return;
    }

    const { gen } = this.link.generation;

    if (!this.#compacting && this.#store.bytes(gen, LOG) > Math.max(COMPACT_MIN, this.#store.bytes(gen, BASE)))
      void this.#compact();
  }

  // A second replica link takes a fresh RDB while the first keeps storing the stream. It becomes current only once
  // it has stored everything the first has, so no acknowledged write lives only in the generation being dropped.
  async #compact(): Promise<void> {
    this.#compacting = true;

    const t0 = Date.now(),
      old = this.link;

    try {
      const next = await openLink(this.#ctx, this.#store, old.generation.gen + 1, (why) => this.shutdown(why));

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
  onBroken: (why: string) => void,
): Promise<ReplicaLink> {
  const socket = dial(ctx);

  await socket.opened;

  return await withTimeout(
    ReplicaLink.open(socket, store, gen, (e) => onBroken(`replication: ${e.message}`)),
    LINK_MS,
    `syncing generation ${gen}`,
  ).catch((e: Error) => {
    socket.close().catch(() => null);
    throw e;
  });
}
