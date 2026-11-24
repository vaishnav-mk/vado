import { concat, isError, str, TYPE } from "../protocol/resp";
import { sameBytes } from "../protocol/bytes";
import { GREETING_MS, PROBE_AFTER_MS, WRITE_FAILED_MS } from "./config";
import { isolateAdd, socketClosed, socketOpened } from "./isolate";
import { readFrames } from "./frames";
import { isPrimary } from "./key-shards";
import { Pending } from "./pending";
import { LOST } from "./replies-text";
import type { Callback, ShardStub, UpKey, Upstream, UpstreamOwner } from "./types";
import { BaseUpstream } from "./upstream";
import { noop } from "../shared";

export class SocketUpstream extends BaseUpstream implements Upstream {
  #socket: Socket;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  readonly #pending = new Pending();
  #out: Uint8Array[] = [];
  #probing = false;
  #probes = 0;
  #lastUsed: number;
  #gen = 0;
  // From the greeting: a reset can leave the socket open but dead, and asking separately could reach a newer one.
  #instanceId: string | null = null;
  #greeting: Uint8Array | null = null;
  #refused = false;

  constructor(owner: UpstreamOwner, key: UpKey, stub: ShardStub) {
    super(owner, key, stub);
    this.#lastUsed = owner.now;
    socketOpened();
    this.#socket = this.#dial();
  }

  send(bytes: Uint8Array, cb: Callback): void {
    if (this.dead) return cb(LOST);
    this.#pending.add(cb, bytes, this.owner.now);
    this.raw(bytes);
  }

  raw(bytes: Uint8Array): void {
    if (this.dead) return;
    this.#lastUsed = this.owner.now;
    this.#out.push(bytes);
    this.schedule();
  }

  idle(now: number, ms: number): boolean {
    return (
      !this.dead &&
      this.#writer !== null &&
      !this.#pending.length &&
      !this.#out.length &&
      !this.inflight &&
      !this.passthrough &&
      now - this.#lastUsed > ms
    );
  }

  check(now: number): void {
    if (
      this.dead ||
      this.#probing ||
      !this.#writer ||
      !this.#pending.length ||
      now - this.#pending.oldest < PROBE_AFTER_MS * 2 ** Math.min(this.#probes, 4)
    )
      return;
    void this.#probe(now);
  }

  close(): void {
    if (this.dead) return;
    socketClosed();
    // Callers wait for earlier replies first; anything still owed gets LOST rather than never.
    this.#abandon(LOST);
  }

  #dial(): Socket {
    const socket = this.stub.connect(this.owner.dial),
      gen = this.#gen;

    this.#writer = socket.writable.getWriter();
    void readFrames(socket, () => gen === this.#gen, this.#frame).then(() => this.#ended(gen));

    return socket;
  }

  async #probe(now: number): Promise<void> {
    this.#probing = true;
    const gen = this.#gen;

    try {
      const current = await this.stub.instance();

      if (gen !== this.#gen) return;

      // No greeting long after sending means no instance ever served this socket.
      if (this.#instanceId === null ? now - this.#pending.oldest > GREETING_MS : current !== this.#instanceId)
        this.#fail();
      else this.#probes++;
    } catch {
      if (gen === this.#gen) this.restub();
    } finally {
      this.#probing = false;
    }
  }

  protected override flush(): void {
    const writer = this.#writer;

    // No writer: dialing again, and the redial resends.
    if (!this.#out.length || this.dead || !writer) return;

    // A copy: request bytes may alias the client's read buffer.
    const b = concat(this.#out),
      gen = this.#gen;

    this.#out = [];
    this.inflight += b.length;
    isolateAdd(b.length);
    void writer.write(b).then(
      () => {
        isolateAdd(-b.length);

        if (gen === this.#gen) {
          this.inflight -= b.length;
          this.owner.wake();
        }
      },
      () => {
        // Whether what was pending ran is for the read side to say: it may still have a restart marker to read.
        isolateAdd(-b.length);
        setTimeout(() => {
          if (gen === this.#gen) this.#fail();
        }, WRITE_FAILED_MS);
      },
    );
  }

  #ended(gen: number): void {
    if (gen !== this.#gen) return;

    // Closed before its greeting, an instance never served the socket: nothing here ran.
    if (this.#instanceId === null && !this.#refused && this.#canRedial()) this.#redial();
    else this.#fail();
  }

  // A replica closing before its greeting isn't ready, and subscriptions live on their socket: only primaries redial.
  #canRedial(): boolean {
    return isPrimary(this.key) && !this.passthrough;
  }

  readonly #frame = (f: Uint8Array): void => {
    this.#lastUsed = this.owner.now;

    if (this.#instanceId === null) {
      if (isError(f)) this.#refused = true;
      else {
        this.#instanceId = str(f.subarray(1, f.length - 2));
        this.#greeting = f;
        this.tries = 0;
      }

      return;
    }

    // The greeting again: the shard is restarting onto new code and ran nothing still pending here.
    if (this.#greeting && sameBytes(f, this.#greeting) && this.#canRedial()) return this.#redial();

    // Replies owed to commands sent before the subscribe (CLIENT SETNAME, PUBLISH) come first, in order.
    if (this.passthrough && !this.#pending.length) return this.passthrough(f);

    if (f[0] === TYPE.push) return this.owner.push(f);
    const cb = this.#pending.next();
    this.#probes = 0;

    if (cb) cb(f);
    else this.owner.push(f);
  };

  // Resent in order on a new socket after a backoff, as the shard may still be restarting; later sends queue behind.
  #redial(): void {
    if (!this.retry(() => this.#resend())) return this.#fail();
    this.#gen++;
    this.#socket.close().catch(noop);
    this.#writer = null;
    this.inflight = 0;
    this.#instanceId = null;
    this.#probes = 0;
    this.owner.lostConnection(this);

    for (const cb of this.#pending.dropTransaction()) cb(LOST);
  }

  #resend(): void {
    if (this.dead) return;
    this.restub();
    this.#socket = this.#dial();
    this.#out = this.#pending.resend(this.owner.setup(), this.owner.now);
    this.flush();
  }

  #fail(): void {
    if (this.dead) return;
    this.#abandon(this.#refused ? this.owner.dropped() : LOST);
    socketClosed();
    this.inflight = 0;
    this.owner.wake();

    if (this.passthrough) this.owner.endPassthrough(true);
    this.owner.dropUpstream(this);
  }

  #abandon(reply: Uint8Array): void {
    this.dead = true;
    this.#gen++;

    for (const cb of this.#pending.clear()) cb(reply);
    this.#socket.close().catch(noop);
  }
}
