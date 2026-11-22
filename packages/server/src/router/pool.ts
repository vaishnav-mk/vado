import { socketsLeft } from "./isolate";
import { RpcUpstream } from "./rpc-upstream";
import { SocketUpstream } from "./socket-upstream";
import type { UpKey, Upstream, UpstreamOwner } from "./types";

const noop = () => {};

/** A connection's upstreams, one per shard (or pub/sub object, or replica) it has talked to. */
export class UpstreamPool {
  readonly #ups = new Map<UpKey, Upstream>();
  readonly #owner: UpstreamOwner;

  constructor(owner: UpstreamOwner) {
    this.#owner = owner;
  }

  /** The live upstream for `key`, made if needed; `needsSocket` refuses an RPC one (WATCH, MULTI). */
  get(key: UpKey, needsSocket = false): Upstream {
    const up = this.#ups.get(key);

    if (up && !up.dead && (!needsSocket || up instanceof SocketUpstream)) return up;

    const socket = needsSocket || key === "pubsub" || socketsLeft(),
      stub = this.#owner.stubOf(key),
      made = socket ? new SocketUpstream(this.#owner, key, stub) : new RpcUpstream(this.#owner, key, stub);

    this.#ups.set(key, made);

    if (socket) for (const c of this.#owner.setup()) made.send(c, noop);

    return made;
  }

  has(key: UpKey): boolean {
    return this.#ups.has(key);
  }

  isRpc(key: UpKey): boolean {
    return this.#ups.get(key) instanceof RpcUpstream;
  }

  drop(up: Upstream): void {
    if (this.#ups.get(up.key) === up) this.#ups.delete(up.key);
  }

  /** Whether any upstream has more than `mark` bytes in flight. */
  above(mark: number): boolean {
    for (const up of this.#ups.values()) if (up.inflight > mark) return true;

    return false;
  }

  sendAll(bytes: Uint8Array, except: UpKey | null = null): void {
    for (const [key, up] of this.#ups) if (key !== except) up.send(bytes, noop);
  }

  /** The watchdog: checks for stalls, and closes sockets idle `idleMs` so idle shards stop being billed. */
  tick(now: number, idleMs: number, keep: number | null): void {
    for (const [key, up] of this.#ups) {
      up.check(now);

      if (key !== "pubsub" && key !== keep && up.idle(now, idleMs)) {
        up.close();
        this.#ups.delete(key);
      }
    }
  }

  closeAll(): void {
    for (const up of this.#ups.values()) up.close();
    this.#ups.clear();
  }
}
