import { concat, frameEnd } from "../protocol/resp";
import { RESTARTING } from "../shard/version";
import { REDIAL_MS, REDIALS, RPC_BATCH_BYTES } from "./config";
import { isolateAdd } from "./isolate";
import { DROPPED, LOST } from "./replies-text";
import type { Callback, ShardStub, UpKey, Upstream, UpstreamOwner } from "./types";

const noop = () => {};

/**
 * An upstream without a socket: each batch is one RPC (shard.execRaw) on a pooled Valkey client, one batch in flight
 * at a time to keep order. Never used for WATCH, MULTI or pub/sub, which need a connection of their own.
 */
export class RpcUpstream implements Upstream {
  readonly key: UpKey;
  dead = false;
  inflight = 0;
  passthrough: Callback | null = null;
  readonly #owner: UpstreamOwner;
  #stub: ShardStub;
  #pending: Callback[] = [];
  #out: Uint8Array[] = [];
  #busy = false;
  #scheduled = false;
  #retries = 0;

  constructor(owner: UpstreamOwner, key: UpKey, stub: ShardStub) {
    this.#owner = owner;
    this.key = key;
    this.#stub = stub;
  }

  // Queued bytes count as in flight at once: with one batch at a time, a slow or cold shard would otherwise let
  // the router queue here without bound until the isolate ran out of memory (Worker error 1102 under load).
  send(bytes: Uint8Array, cb: Callback): void {
    this.#pending.push(cb);
    this.#out.push(bytes.slice());
    this.inflight += bytes.length;
    isolateAdd(bytes.length);
    this.#schedule();
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

  #schedule(): void {
    if (this.#scheduled || this.#busy) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#flush();
    });
  }

  #flush(): void {
    if (this.#busy || !this.#out.length) return;

    let take = 0,
      bytes = 0;

    // whole requests, up to the batch cap
    while (take < this.#out.length && (take === 0 || bytes + this.#out[take].length <= RPC_BATCH_BYTES))
      bytes += this.#out[take++].length;

    const cbs = this.#pending.splice(0, take),
      parts = this.#out.splice(0, take);

    this.#busy = true;
    void this.#stub.execRaw(concat(parts), cbs.length, this.#owner.proto).then(
      (reply) => {
        this.#retries = 0;
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
    this.#owner.wake();
    this.#schedule();
  }

  #failed(cause: unknown, cbs: Callback[], parts: Uint8Array[], bytes: number): void {
    const message = cause instanceof Error ? cause.message : "";

    // Refused, unrun, by a shard restarting onto new code: again, in order, on its next instance.
    if (message.includes(RESTARTING) && ++this.#retries <= REDIALS) {
      this.#pending.unshift(...cbs);
      this.#out.unshift(...parts);
      // the old stub breaks when the object resets
      this.#stub = this.#owner.stubOf(this.key);
      setTimeout(
        () => {
          this.#busy = false;
          this.#flush();
        },
        REDIAL_MS * 2 ** (this.#retries - 1),
      );

      return;
    }

    // A stub whose object reset stays broken: drop this upstream so the next command gets a fresh stub.
    this.dead = true;
    const reply = DROPPED.test(message) ? this.#owner.dropped() : LOST;

    for (const cb of cbs) cb(reply);
    this.#done(bytes);
  }
}
