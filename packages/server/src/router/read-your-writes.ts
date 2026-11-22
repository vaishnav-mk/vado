import { READ_YOUR_WRITES_MS } from "../replication/config";

/**
 * While a write to a shard is in flight, and for READ_YOUR_WRITES_MS after its reply, a connection reads that
 * shard from its primary, not a replica that may not have the write yet.
 */
export class ReadYourWrites {
  // shard -> writes in flight
  readonly #writing = new Map<number, number>();
  // shard -> when the last write's reply arrived
  readonly #wrote = new Map<number, number>();

  start(shard: number): void {
    this.#writing.set(shard, (this.#writing.get(shard) ?? 0) + 1);
  }

  done(shard: number): void {
    this.#writing.set(shard, (this.#writing.get(shard) ?? 0) - 1);
    this.#wrote.set(shard, Date.now());
  }

  /** A fan-out that may write (FLUSHALL, FUNCTION LOAD) counts as a write to every shard. */
  all(shards: number): void {
    for (let i = 0; i < shards; i++) this.#wrote.set(i, Date.now());
  }

  /** Whether the shard's replicas may lack this connection's writes. */
  recent(shard: number, now: number): boolean {
    return (this.#writing.get(shard) ?? 0) > 0 || now - (this.#wrote.get(shard) ?? -Infinity) < READ_YOUR_WRITES_MS;
  }

  /** Every shard this connection has written to. */
  shards(): number[] {
    return [...new Set([...this.#wrote.keys(), ...this.#writing.keys()])];
  }
}
