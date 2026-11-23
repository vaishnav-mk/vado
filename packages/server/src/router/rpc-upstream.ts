import { concat, frameEnd } from "../protocol/resp";
import { RESTARTING } from "../shard/version";
import { RPC_BATCH_BYTES } from "./config";
import { isolateAdd } from "./isolate";
import { LOST, lostOr } from "./replies-text";
import type { Callback, Upstream } from "./types";
import { BaseUpstream } from "./upstream";
import { messageOf, noop } from "../shared";

// One batch in flight at a time keeps order. Never WATCH, MULTI or pub/sub: they need a connection of their own.
export class RpcUpstream extends BaseUpstream implements Upstream {
  #pending: Callback[] = [];
  #out: Uint8Array[] = [];
  #busy = false;

  // Queued bytes count at once: else a slow shard lets the router queue until the isolate dies (error 1102).
  send(bytes: Uint8Array, cb: Callback): void {
    this.#pending.push(cb);
    this.#out.push(bytes.slice());
    this.inflight += bytes.length;
    isolateAdd(bytes.length);
    this.schedule();
  }

  raw(bytes: Uint8Array): void {
    this.send(bytes, noop);
  }

  check(): void {}

  idle(): boolean {
    return false;
  }

  close(): void {
    this.dead = true;
  }

  protected override flush(): void {
    if (this.#busy || !this.#out.length) return;

    let take = 0,
      bytes = 0;

    while (take < this.#out.length && (take === 0 || bytes + this.#out[take].length <= RPC_BATCH_BYTES))
      bytes += this.#out[take++].length;

    const cbs = this.#pending.splice(0, take),
      parts = this.#out.splice(0, take);

    this.#busy = true;
    void this.stub.execRaw(concat(parts), cbs.length, this.owner.proto).then(
      (reply) => {
        this.tries = 0;
        let i = 0;

        for (const cb of cbs) {
          const e = frameEnd(reply, i, reply.length);

          if (e < 0) cb(LOST);
          else {
            cb(reply.slice(i, e));
            i = e;
          }
        }

        this.#done(bytes);
      },
      (cause: unknown) => this.#failed(cause, cbs, parts, bytes),
    );
  }

  #done(bytes: number): void {
    this.#busy = false;
    this.inflight -= bytes;
    isolateAdd(-bytes);
    this.owner.wake();
    this.schedule();
  }

  #failed(cause: unknown, cbs: Callback[], parts: Uint8Array[], bytes: number): void {
    // Refused, unrun, by a shard restarting onto new code: again, in order, on its next instance.
    const again = () => {
      this.#busy = false;
      this.flush();
    };

    if (messageOf(cause).includes(RESTARTING) && this.retry(again)) {
      this.#pending.unshift(...cbs);
      this.#out.unshift(...parts);
      this.restub();

      return;
    }

    // The next command gets a fresh upstream, and stub.
    this.dead = true;
    const reply = lostOr(cause, () => this.owner.dropped());

    for (const cb of cbs) cb(reply);
    this.#done(bytes);
  }
}
