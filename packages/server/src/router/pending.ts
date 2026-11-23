import { EXEC, MULTI } from "./replies-text";
import type { Callback } from "./types";
import { noop } from "../shared";

/** The requests a socket has sent and not had replies to, in order. Parallel arrays, so add() allocates nothing. */
export class Pending {
  #callbacks: Callback[] = [];
  #sent: number[] = [];
  // Their bytes, to send again on a new socket. Views of the client's buffer never change (append), so no copy.
  #again: Uint8Array[] = [];
  // the shard has run a MULTI sent here and not yet its EXEC
  #inTx = false;

  get length(): number {
    return this.#callbacks.length;
  }

  /** When the oldest was sent. */
  get oldest(): number {
    return this.#sent[0];
  }

  add(cb: Callback, bytes: Uint8Array, now: number): void {
    this.#callbacks.push(cb);
    this.#sent.push(now);
    this.#again.push(bytes);
  }

  /** The callback the next reply is for, or undefined if none is owed. */
  next(): Callback | undefined {
    const cb = this.#callbacks.shift();
    this.#sent.shift();
    const bytes = this.#again.shift();

    if (bytes === MULTI) this.#inTx = true;
    else if (bytes === EXEC) this.#inTx = false;

    return cb;
  }

  /** A transaction whose MULTI ran on a socket that closed went with it, EXEC unrun: its requests, to get LOST. */
  dropTransaction(): Callback[] {
    if (!this.#inTx) return [];
    const n = this.#again.indexOf(EXEC) + 1 || this.#again.length;
    this.#sent.splice(0, n);
    this.#again.splice(0, n);
    this.#inTx = false;

    return this.#callbacks.splice(0, n);
  }

  /** For a new socket: `setup` first (replies unwanted), then everything owed. Returns all the bytes to send. */
  resend(setup: Uint8Array[], now: number): Uint8Array[] {
    this.#callbacks.unshift(...setup.map(() => noop));
    this.#again.unshift(...setup);
    this.#sent = this.#callbacks.map(() => now);

    return [...this.#again];
  }

  /** Forgets every request; returns their callbacks. */
  clear(): Callback[] {
    const callbacks = this.#callbacks;
    this.#callbacks = [];
    this.#sent = [];
    this.#again = [];

    return callbacks;
  }
}
