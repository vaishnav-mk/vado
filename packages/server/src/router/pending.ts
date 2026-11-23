import { EXEC, MULTI } from "./replies-text";
import type { Callback } from "./types";
import { noop } from "../shared";

// Parallel arrays, so add() allocates nothing.
export class Pending {
  #callbacks: Callback[] = [];
  #sent: number[] = [];
  // Views of the client's buffer never change (append), so resending needs no copy.
  #again: Uint8Array[] = [];
  #multiRan = false;

  get length(): number {
    return this.#callbacks.length;
  }

  get oldest(): number {
    return this.#sent[0];
  }

  add(cb: Callback, bytes: Uint8Array, now: number): void {
    this.#callbacks.push(cb);
    this.#sent.push(now);
    this.#again.push(bytes);
  }

  next(): Callback | undefined {
    const cb = this.#callbacks.shift();
    this.#sent.shift();
    const bytes = this.#again.shift();

    if (bytes === MULTI) this.#multiRan = true;
    else if (bytes === EXEC) this.#multiRan = false;

    return cb;
  }

  // A transaction whose MULTI ran on a socket that closed went with it, EXEC unrun: its requests get LOST.
  dropTransaction(): Callback[] {
    if (!this.#multiRan) return [];
    const n = this.#again.indexOf(EXEC) + 1 || this.#again.length;
    this.#sent.splice(0, n);
    this.#again.splice(0, n);
    this.#multiRan = false;

    return this.#callbacks.splice(0, n);
  }

  resend(setup: Uint8Array[], now: number): Uint8Array[] {
    this.#callbacks.unshift(...setup.map(() => noop));
    this.#again.unshift(...setup);
    this.#sent = this.#callbacks.map(() => now);

    return [...this.#again];
  }

  clear(): Callback[] {
    const callbacks = this.#callbacks;
    this.#callbacks = [];
    this.#sent = [];
    this.#again = [];

    return callbacks;
  }
}
