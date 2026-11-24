import type { WasmHost } from "./host/wasm-host";
import { resetSoon } from "./reset";
import { dialedFrom, RESTARTING } from "../shard/version";
import { noop } from "../shared";

export class ReplicaRole {
  ready = false;
  #ctx: DurableObjectState;
  #host: WasmHost;
  #restartFor: (t: number) => number | null;
  #stream: Socket | null = null;

  constructor(ctx: DurableObjectState, host: WasmHost, restartFor: (t: number) => number | null) {
    this.#ctx = ctx;
    this.#host = host;
    this.#restartFor = restartFor;
  }

  // A stream that ends resets the replica, as retire() does: the primary's own close doesn't arrive.
  async stream(socket: Socket, address: string): Promise<void> {
    const from = dialedFrom(address, "repl");

    // Its copy fails, and it copies again REPL_RETRY_MS later, onto the newer code.
    if (from !== null && this.#restartFor(from) !== null) {
      await socket.close().catch(noop);

      return await resetSoon(this.#ctx, RESTARTING);
    }

    void this.#stream?.close().catch(noop); // from a primary that reset, so never closed it
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

  copied(): void {
    if (this.#stream) this.ready = true;
  }
}
