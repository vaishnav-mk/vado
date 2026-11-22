import { concat } from "../protocol/resp";
import { DROPPED, EMPTY, LOST } from "./replies-text";
import type { ReplyOwner } from "./types";

/** One reply's place in the connection's order; `b` is set once the reply is known. */
export interface Slot {
  b: Uint8Array | null;
}

const noop = () => {};

/**
 * A connection's replies, written in request order. Socket upstreams keep per-shard order on their own; a command
 * that goes by RPC doesn't, so it waits for every earlier reply, and later requests wait for it (viaRpc).
 */
export class ReplyQueue {
  /** Reply bytes written to the client and not yet acknowledged. */
  inflight = 0;
  /** Later requests wait for this before they are parsed (an AUTH switching databases, an RPC-path command). */
  pending: Promise<void> | null = null;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #owner: ReplyOwner;
  readonly #queue: Slot[] = [];
  // slot -> wake, for an RPC-path command waiting on every earlier reply
  readonly #onHead = new Map<Slot, () => void>();
  // passthrough frames waiting for the queue to drain
  #pushes: Uint8Array[] = [];
  #flushing = false;
  #emptied: (() => void) | null = null;

  constructor(writer: WritableStreamDefaultWriter<Uint8Array>, owner: ReplyOwner) {
    this.#writer = writer;
    this.#owner = owner;
  }

  slot(): Slot {
    const s: Slot = { b: null };
    this.#queue.push(s);

    return s;
  }

  resolve(s: Slot, b: Uint8Array): void {
    s.b = b;

    if (!this.#flushing) {
      this.#flushing = true;
      queueMicrotask(this.#flush);
    }
  }

  reply(b: Uint8Array): void {
    this.resolve(this.slot(), b);
  }

  /** Frames not owed to a request (RESP3 pushes, passthrough): sent once nothing earlier is owed. */
  push(frame: Uint8Array): void {
    if (this.#queue.length) this.#pushes.push(frame.slice());
    else this.#write(frame.slice());
  }

  /** Resolves once every reply before `s` is written. */
  afterEarlier(s: Slot): Promise<void> {
    return this.#queue[0] === s ? Promise.resolve() : new Promise((wake) => this.#onHead.set(s, wake));
  }

  /** Resolves once every request so far has its reply. */
  afterAll(): Promise<void> {
    const s = this.slot();

    return this.afterEarlier(s).then(() => this.resolve(s, EMPTY));
  }

  /** Later requests wait for `p`. */
  hold(p: Promise<void>): void {
    const held: Promise<void> = p.then(noop, noop).finally(() => {
      if (this.pending === held) this.pending = null;
    });

    this.pending = held;
  }

  /**
   * An RPC rejects only when its shard can't answer (Valkey errors come back as values), so the command may or
   * may not have run: LOST, as on the socket path.
   */
  lost(s: Slot): (cause: unknown) => void {
    return (cause) => this.resolve(s, this.#failure(cause));
  }

  /** Runs `work` after every earlier reply, holding later requests until its reply is in place. */
  viaRpc(work: () => Uint8Array | Promise<Uint8Array>): void {
    const s = this.slot();
    this.hold(
      this.afterEarlier(s)
        .then(work)
        .then((b) => this.resolve(s, b), this.lost(s)),
    );
  }

  /** Resolves once every reply is written, or after `ms`. */
  drain(ms: number): Promise<void> {
    if (!this.#queue.length) return Promise.resolve();

    return new Promise((done) => {
      const timer = setTimeout(done, ms);

      this.#emptied = () => {
        clearTimeout(timer);
        done();
      };
    });
  }

  close(): Promise<void> {
    return this.#writer.close().catch(noop);
  }

  #failure(cause: unknown): Uint8Array {
    return cause instanceof Error && DROPPED.test(cause.message) ? this.#owner.dropped() : LOST;
  }

  // Once per microtask, not once per reply: a pipelined batch is one write.
  readonly #flush = () => {
    this.#flushing = false;

    const queue = this.#queue,
      parts: Uint8Array[] = [];

    let n = 0;

    for (let b; n < queue.length && (b = queue[n].b); n++) parts.push(b);

    if (n) queue.splice(0, n);
    const wake = queue.length ? this.#onHead.get(queue[0]) : undefined;

    if (wake) {
      this.#onHead.delete(queue[0]);
      wake();
    }

    if (!queue.length) {
      if (this.#pushes.length) {
        parts.push(...this.#pushes);
        this.#pushes = [];
      }

      this.#emptied?.();
      this.#emptied = null;
    }

    if (parts.length) this.#write(parts.length === 1 ? parts[0] : concat(parts));
  };

  // Client-bound bytes stay out of the isolate budget: they drain only if that client reads. ROUTER_HIGH_WATER
  // bounds them per connection instead.
  #write(b: Uint8Array): void {
    this.inflight += b.length;
    void this.#writer.write(b).then(
      () => {
        this.inflight -= b.length;
        this.#owner.wake();
      },
      () => this.#owner.close(),
    );
  }
}
