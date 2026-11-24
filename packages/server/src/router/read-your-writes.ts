import { READ_YOUR_WRITES_MS } from "./config";

export class ReadYourWrites {
  readonly #writing = new Map<number, number>();
  readonly #wroteAt = new Map<number, number>();

  start(shard: number): void {
    this.#writing.set(shard, (this.#writing.get(shard) ?? 0) + 1);
  }

  done(shard: number): void {
    this.#writing.set(shard, (this.#writing.get(shard) ?? 0) - 1);
    this.#wroteAt.set(shard, Date.now());
  }

  all(shards: number): void {
    for (let i = 0; i < shards; i++) this.#wroteAt.set(i, Date.now());
  }

  recent(shard: number, now: number): boolean {
    return (this.#writing.get(shard) ?? 0) > 0 || now - (this.#wroteAt.get(shard) ?? -Infinity) < READ_YOUR_WRITES_MS;
  }

  shards(): number[] {
    return [...new Set([...this.#wroteAt.keys(), ...this.#writing.keys()])];
  }
}
