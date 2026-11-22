/**
 * Values fetched once per isolate (database records, command tables). Each connection is its own request, and a
 * promise settles only in the request that made it (handle_cross_request_promise_resolution): a fetch another
 * connection started is shared while it lasts, and if it fails or its connection ends first, the waiter fetches for
 * itself. Settled values are kept, so later connections never wait on another request at all.
 */
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

    // Set before any await, so concurrent callers find it.
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

  /** The value if this isolate has it, without fetching. */
  peek(key: K): V | undefined {
    return this.#values.get(key);
  }

  delete(key: K): boolean {
    this.#fetching.delete(key);

    return this.#values.delete(key);
  }
}
