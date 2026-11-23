import { REDIAL_MS, REDIALS } from "./config";
import type { Callback, ShardStub, UpKey, UpstreamOwner } from "./types";

export abstract class BaseUpstream {
  readonly key: UpKey;
  dead = false;
  inflight = 0;
  passthrough: Callback | null = null;
  protected readonly owner: UpstreamOwner;
  protected stub: ShardStub;
  protected tries = 0;
  #scheduled = false;

  constructor(owner: UpstreamOwner, key: UpKey, stub: ShardStub) {
    this.owner = owner;
    this.key = key;
    this.stub = stub;
  }

  protected abstract flush(): void;

  protected schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.flush();
    });
  }

  // A stub of an instance that reset stays broken.
  protected restub(): void {
    this.stub = this.owner.stubOf(this.key);
  }

  protected retry(again: () => void): boolean {
    if (++this.tries > REDIALS) return false;
    setTimeout(again, REDIAL_MS * 2 ** (this.tries - 1));

    return true;
  }
}
