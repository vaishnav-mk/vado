// A small RESP client over a socket: pipelined calls, replies decoded by decode() or decodeTyped().
import { decode } from "./decode";
import { command, concat, frameEnd } from "./resp";
import type { CommandArg, Reply, RespSocket } from "./types";

type Parse<T> = (frame: Uint8Array) => [T, number];

export class RespClient {
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buf: Uint8Array = new Uint8Array(0);
  #stallMs: number;

  constructor(socket: RespSocket, stallMs = 30_000) {
    this.#writer = socket.writable.getWriter();
    this.#reader = socket.readable.getReader();
    this.#stallMs = stallMs;
  }

  /** Sends every command at once, then reads one reply for each. */
  async call(...cmds: CommandArg[][]): Promise<Reply[]> {
    await this.send(...cmds);

    return this.read(cmds.length);
  }

  /** Sends every command at once, without reading the replies. */
  send(...cmds: CommandArg[][]): Promise<void> {
    return this.#writer.write(concat(cmds.map(command)));
  }

  /** Reads the next `n` replies. A connection that sends nothing for stallMs is an error, not a hang. */
  read(n: number): Promise<Reply[]>;
  read<T>(n: number, parse: Parse<T>): Promise<T[]>;
  async read<T>(n: number, parse?: Parse<T>): Promise<(T | Reply)[]> {
    const decodeOne: Parse<T | Reply> = parse ?? decode;
    const out = [];
    let pos = 0;

    while (out.length < n) {
      const end = frameEnd(this.#buf, pos, this.#buf.length);

      if (end >= 0) {
        out.push(decodeOne(this.#buf.subarray(pos, end))[0]);
        pos = end;
        continue;
      }

      const { value, done } = await this.#next(`reply ${out.length + 1}/${n}`);

      if (done) throw new Error(`connection closed after ${out.length}/${n} replies`);
      this.#buf = concat([this.#buf.subarray(pos), value]);
      pos = 0;
    }

    this.#buf = this.#buf.subarray(pos);

    return out;
  }

  close(): void {
    this.#writer.close().catch(() => {});
  }

  async #next(waitingFor: string): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stall = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`stalled ${this.#stallMs / 1000}s waiting for ${waitingFor}`)),
        this.#stallMs,
      );
    });

    try {
      return await Promise.race([this.#reader.read(), stall]);
    } finally {
      clearTimeout(timer);
    }
  }
}
