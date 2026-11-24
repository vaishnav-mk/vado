import { concat, EMPTY } from "../protocol/resp";
import { lostOr } from "./replies-text";
import type { ReplyOwner, Slot } from "./types";
import { noop } from "../shared";

export class ReplyQueue {
  inflight = 0;
  pending: Promise<void> | null = null;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #owner: ReplyOwner;
  readonly #queue: Slot[] = [];
  readonly #onHead = new Map<Slot, () => void>();
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

  push(frame: Uint8Array): void {
    if (this.#queue.length) this.#pushes.push(frame);
    else this.#write(frame);
  }

  afterEarlier(s: Slot): Promise<void> {
    return this.#queue[0] === s ? Promise.resolve() : new Promise((wake) => this.#onHead.set(s, wake));
  }

  afterAll(): Promise<void> {
    const s = this.slot();

    return this.afterEarlier(s).then(() => this.resolve(s, EMPTY));
  }

  hold(p: Promise<void>): void {
    const held: Promise<void> = p.then(noop, noop).finally(() => {
      if (this.pending === held) this.pending = null;
    });

    this.pending = held;
  }

  // An RPC rejects only when its shard can't answer (Valkey errors are values), so it may or may not have run.
  lost(s: Slot): (e: Error) => void {
    return (e) =>
      this.resolve(
        s,
        lostOr(e, () => this.#owner.dropped()),
      );
  }

  viaRpc(work: () => Uint8Array | Promise<Uint8Array>): void {
    const s = this.slot();
    this.hold(
      this.afterEarlier(s)
        .then(work)
        .then((b) => this.resolve(s, b), this.lost(s)),
    );
  }

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

  // Not in the isolate budget: these drain only if this client reads. ROUTER_HIGH_WATER bounds them instead.
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
