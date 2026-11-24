import { concat, HELLO3 } from "../protocol/resp";
import type { Protocol } from "../protocol/types";
import { readFrames } from "../router/frames";
import { noop } from "../shared";
import { ROLE, roleOffset } from "./proxy";
import type { Fence, MuxBatch } from "./types";

// Each batch carries its own ROLE fence, so a slow fence holds back only its caller.
export class Mux {
  broken: Error | null = null;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #fence: Fence;
  #batches: MuxBatch[] = [];
  #skip: number; // HELLO's reply

  constructor(socket: Socket, fence: Fence, proto: Protocol) {
    this.#writer = socket.writable.getWriter();
    this.#fence = fence;
    this.#skip = proto === 3 ? 1 : 0;

    if (proto === 3) void this.#writer.write(HELLO3).catch((e: Error) => this.#fail(e));
    void readFrames(
      socket,
      () => this.broken === null,
      (f) => this.#frame(f),
    ).then(() => this.#fail(new Error("the server closed the shared connection")));
  }

  exec(bytes: Uint8Array, count: number): Promise<Uint8Array> {
    if (this.broken) return Promise.reject(this.broken);

    return new Promise((resolve, reject) => {
      this.#batches.push({ count, frames: [], resolve, reject });
      this.#writer.write(concat([bytes, ROLE])).catch((e: Error) => this.#fail(e));
    });
  }

  #frame(f: Uint8Array): void {
    if (this.#skip > 0) {
      this.#skip--;

      return;
    }

    const batch = this.#batches[0];

    if (!batch) return;
    batch.frames.push(f);

    if (batch.frames.length <= batch.count) return;
    this.#batches.shift();
    const replies = concat(batch.frames.slice(0, -1));

    this.#fence(roleOffset(f)).then(() => batch.resolve(replies), batch.reject);
  }

  close(): void {
    this.#fail(new Error("closed"));
    this.#writer.close().catch(noop);
  }

  #fail(e: Error): void {
    if (this.broken) return;
    this.broken = e;

    for (const b of this.#batches) b.reject(e);
    this.#batches = [];
  }
}
