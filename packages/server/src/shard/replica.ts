// A read replica: it serves reads only once its primary's copy has fully arrived, and only while that stream lasts.
import type { ValkeyHost } from "./host/valkey-host";
import { resetSoon } from "./reset";
import { dialedFrom, RESTARTING } from "./version";

export class ReplicaRole {
  ready = false;
  #ctx: DurableObjectState;
  #host: ValkeyHost;
  #restartFor: (t: number) => number | null;
  #stream: Socket | null = null; // the current stream from the primary

  constructor(ctx: DurableObjectState, host: ValkeyHost, restartFor: (t: number) => number | null) {
    this.#ctx = ctx;
    this.#host = host;
    this.#restartFor = restartFor;
  }

  /** The primary's stream, dialed "repl" or "repl-<ms>". It starts a fresh copy, so reads stop until it has
   *  arrived. A stream that ends resets the replica, as retire() does: the primary's own close doesn't arrive. */
  async stream(socket: Socket, address: string): Promise<void> {
    const from = dialedFrom(address, "repl");

    // A primary on newer code: restart onto it first. Its copy fails, and it copies again REPL_RETRY_MS later.
    if (from !== null && this.#restartFor(from) !== null) {
      await socket.close().catch(() => {});

      return await resetSoon(this.#ctx, RESTARTING);
    }

    void this.#stream?.close().catch(() => {}); // from a primary that reset, so never closed it
    this.#stream = socket;
    this.ready = false;

    try {
      await this.#host.serve(socket, null, true);
    } finally {
      if (this.#stream === socket) {
        this.#stream = null;
        this.ready = false;
        void resetSoon(this.#ctx, "replica stream ended");
      }
    }
  }

  /** The primary's copy has arrived: serve reads, unless the stream ended meanwhile. */
  copied(): void {
    if (this.#stream) this.ready = true;
  }
}
