import { concat, str } from "../protocol/resp";
import { sameBytes } from "./buffer";
import { GREETING_MS, PROBE_AFTER_MS, REDIAL_MS, REDIALS } from "./config";
import { isolateAdd, socketClosed, socketOpened } from "./isolate";
import { readFrames } from "./frames";
import { isPrimary } from "./key-shards";
import { Pending } from "./pending";
import { LOST } from "./replies-text";
import type { Callback, ShardStub, UpKey, Upstream, UpstreamOwner } from "./types";
import { noop } from "../shared";

// A socket whose write failed is dead unless its read side ends by then (it may still hold a restart marker).
const WRITE_FAILED_MS = 2_000;

/** One socket to a shard's Valkey: replies come back in the order requests went. */
export class SocketUpstream implements Upstream {
  readonly key: UpKey;
  dead = false;
  inflight = 0;
  passthrough: Callback | null = null;
  readonly #owner: UpstreamOwner;
  #stub: ShardStub;
  #socket: Socket;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  readonly #pending = new Pending();
  #out: Uint8Array[] = [];
  #scheduled = false;
  #probing = false;
  #probes = 0; // watchdog checks since the last reply, each waiting twice as long
  #lastUsed: number;
  #redials = 0; // tries since the last greeting
  #gen = 0; // which socket: callbacks from an older one are ignored
  // The instance that accepted the socket, from its greeting. A reset can leave the socket open but dead; the
  // watchdog compares this with the current instance (asking separately could reach a newer one).
  #instanceId: string | null = null;
  #greeting: Uint8Array | null = null;
  #refused = false; // a dropped shard's "-ERR database dropped" came instead of a greeting

  constructor(owner: UpstreamOwner, key: UpKey, stub: ShardStub) {
    this.#owner = owner;
    this.key = key;
    this.#stub = stub;
    this.#lastUsed = owner.now;
    socketOpened();
    this.#socket = this.#dial();
  }

  send(bytes: Uint8Array, cb: Callback): void {
    if (this.dead) return cb(LOST);
    this.#pending.add(cb, bytes, this.#owner.now);
    this.raw(bytes);
  }

  raw(bytes: Uint8Array): void {
    if (this.dead) return;
    this.#lastUsed = this.#owner.now;
    this.#out.push(bytes);

    if (!this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(this.#flush);
    }
  }

  /** Nothing outstanding and unused for `ms`: the router may close it so the shard can sleep. */
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
    const socket = this.#stub.connect(this.#owner.dial),
      gen = this.#gen;

    this.#writer = socket.writable.getWriter();
    void readFrames(socket, () => gen === this.#gen, this.#frame).then(() => this.#ended(gen));

    return socket;
  }

  async #probe(now: number): Promise<void> {
    this.#probing = true;
    const gen = this.#gen;

    try {
      const current = await this.#stub.instance();

      if (gen !== this.#gen) return;

      // No greeting long after sending means no instance ever served this socket.
      if (this.#instanceId === null ? now - this.#pending.oldest > GREETING_MS : current !== this.#instanceId)
        this.#fail();
      else this.#probes++;
    } catch {
      // A stub of an instance that reset stays broken: the next check tries a fresh one.
      if (gen === this.#gen) this.#stub = this.#owner.stubOf(this.key);
    } finally {
      this.#probing = false;
    }
  }

  readonly #flush = () => {
    this.#scheduled = false;
    const writer = this.#writer;

    // no writer: dialing again, and the redial resends
    if (!this.#out.length || this.dead || !writer) return;

    // a copy: request bytes may alias the client's read buffer
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
          this.#owner.wake();
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
  };

  #ended(gen: number): void {
    if (gen !== this.#gen) return;

    // Closed before its greeting, an instance never served the socket: nothing here ran.
    if (this.#instanceId === null && !this.#refused && this.#canRedial()) this.#redial();
    else this.#fail();
  }

  // A replica that closes before its greeting isn't ready (reads go to the primary), and subscriptions live on
  // their socket: only a primary's socket carries nothing the next one can't be given.
  #canRedial(): boolean {
    return isPrimary(this.key) && !this.passthrough;
  }

  readonly #frame = (f: Uint8Array): void => {
    this.#lastUsed = this.#owner.now;

    if (this.#instanceId === null) {
      if (f[0] === 45) this.#refused = true;
      else {
        this.#instanceId = str(f.subarray(1, f.length - 2));
        this.#greeting = f;
        this.#redials = 0;
      }

      return;
    }

    // The greeting again: the shard is restarting onto new code and ran nothing still pending here.
    if (this.#greeting && sameBytes(f, this.#greeting) && this.#canRedial()) return this.#redial();

    // Replies owed to commands sent before the subscribe (CLIENT SETNAME, PUBLISH) come first, in order.
    if (this.passthrough && !this.#pending.length) return this.passthrough(f);

    if (f[0] === 62) return this.#owner.push(f); // a RESP3 push
    const cb = this.#pending.next();
    this.#probes = 0;

    if (cb) cb(f);
    else this.#owner.push(f);
  };

  // The shard closed this socket and ran nothing pending on it: send it all again, in order, on a new socket,
  // after a backoff (it may still be restarting). Commands sent meanwhile queue behind.
  #redial(): void {
    if (++this.#redials > REDIALS) return this.#fail();
    this.#gen++;
    this.#socket.close().catch(noop);
    this.#writer = null;
    this.inflight = 0;
    this.#instanceId = null;
    this.#probes = 0;
    // a WATCH there is gone
    this.#owner.lostConnection(this);

    for (const cb of this.#pending.dropTransaction()) cb(LOST);

    setTimeout(() => this.#resend(), REDIAL_MS * 2 ** (this.#redials - 1));
  }

  #resend(): void {
    if (this.dead) return;
    // a stub of the instance that restarted stays broken
    this.#stub = this.#owner.stubOf(this.key);
    this.#socket = this.#dial();
    // The new socket gets this connection's settings (RESP3, client name) first, then everything owed.
    this.#out = this.#pending.resend(this.#owner.setup(), this.#owner.now);
    this.#flush();
  }

  #fail(): void {
    if (this.dead) return;
    this.#abandon(this.#refused ? this.#owner.dropped() : LOST);
    socketClosed();
    this.inflight = 0;
    this.#owner.wake();

    if (this.passthrough) this.#owner.endPassthrough(true);
    this.#owner.dropUpstream(this);
  }

  #abandon(reply: Uint8Array): void {
    this.dead = true;
    this.#gen++;

    for (const cb of this.#pending.clear()) cb(reply);
    this.#socket.close().catch(noop);
  }
}
