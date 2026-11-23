// A promise settles only in the request that made it (handle_cross_request_promise_resolution), so a waiter whose
// shared fetch fails or whose fetching connection ends fetches for itself, and settled values are kept.
export class IsolateCache<K, V extends object> {
  readonly #values = new Map<K, V>();
  readonly #fetching = new Map<K, Promise<V>>();

  async get(key: K, fetch: () => Promise<V>): Promise<V> {
    const value = this.#values.get(key);

    if (value) return value;
    const shared = this.#fetching.get(key);

    if (shared) {
      const got = await shared.catch(() => undefined);

      if (got) return got;
    }

    const mine = fetch();
    this.#fetching.set(key, mine);

    try {
      const value = await mine;
      this.#values.set(key, value);

      return value;
    } finally {
      if (this.#fetching.get(key) === mine) this.#fetching.delete(key);
    }
  }

  peek(key: K): V | undefined {
    return this.#values.get(key);
  }

  delete(key: K): boolean {
    this.#fetching.delete(key);

    return this.#values.delete(key);
  }
}
