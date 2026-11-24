import { command, concat, lineEnd, str } from "../protocol/resp";
import { noop } from "../shared";
import { ACK_MS, FENCE_MS } from "./config";
import { storeRdb } from "./rdb";
import { LOG } from "./store";
import type { BoxStore, Generation } from "./store";
import type { Resume, Waiter } from "./types";

export const CANT_CONTINUE = "the server can't continue the stored stream";

// This object as a replica of the container's server, storing its replication stream.
export class StreamLink {
  received = 0; // offset of the last byte stored; the output gate holds what this object sends until it commits
  broken: Error | null = null;
  generation: Generation = { gen: 0, replid: "", offset: 0 };
  continued = false; // went on in the stored generation, with no new copy
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #store: BoxStore;
  readonly #socket: Socket;
  #buf: Uint8Array = new Uint8Array(0);
  #waiters: Waiter[] = [];
  #ack: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  #catchUp: { other: StreamLink; resolve: () => void } | null = null;

  private constructor(socket: Socket, store: BoxStore) {
    this.#socket = socket;
    this.#reader = socket.readable.getReader();
    this.#writer = socket.writable.getWriter();
    this.#store = store;
  }

  // The caller makes the link's generation current.
  static async open(
    socket: Socket,
    store: BoxStore,
    gen: number,
    resume: Resume | null,
    onBroken: (e: Error) => void,
  ): Promise<StreamLink> {
    const link = new StreamLink(socket, store);

    await link.#sync(gen, resume);
    void link.#stream().catch((e: Error) => link.#break(e, onBroken));

    return link;
  }

  reached(offset: number, ms: number): Promise<void> {
    if (this.broken) return Promise.reject(this.broken);

    if (this.received >= offset) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const waiter = { offset, resolve, reject };

      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new Error(`replication stream stalled ${ms} ms short of offset ${offset}`));
      }, ms);

      waiter.resolve = () => {
        clearTimeout(timer);
        resolve();
      };

      this.#waiters.push(waiter);
    });
  }

  caughtUp(other: StreamLink): Promise<void> {
    if (this.received >= other.received) return Promise.resolve();

    return new Promise((resolve) => {
      this.#catchUp = { other, resolve };
    });
  }

  // Both links replicate one server, so offsets mean the same on each.
  handOver(next: StreamLink): void {
    for (const w of this.#waiters) next.reached(w.offset, FENCE_MS).then(w.resolve, w.reject);
    this.#waiters = [];
    this.close();
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#ack ?? undefined);
    this.#socket.close().catch(noop);
  }

  async #sync(gen: number, resume: Resume | null): Promise<void> {
    // One at a time: the server refuses PSYNC while replies are still owed on the connection.
    for (const args of [
      ["PING"],
      ["REPLCONF", "listening-port", "6380"],
      ["REPLCONF", "capa", "eof", "capa", "psync2"],
    ]) {
      await this.#writer.write(command(args));
      const line = await this.#line();

      if (line.startsWith("-")) throw new Error(`replication handshake: ${line}`);
    }

    // The server answers CONTINUE only if its history holds exactly the bytes after `resume.offset`.
    await this.#writer.write(
      command(resume ? ["PSYNC", resume.replid, String(resume.offset + 1)] : ["PSYNC", "?", "-1"]),
    );
    const [kind, replid = "", offset = "0"] = (await this.#line()).split(" ");

    if (kind === "+CONTINUE" && resume) {
      const shift = resume.offset - this.#store.bytes(resume.from.gen, LOG);

      this.generation = { ...resume.from, master: replid || resume.replid, shift };
      this.received = resume.offset;
      this.continued = true;
    } else if (kind === "+FULLRESYNC") {
      if (resume?.only) throw new Error(CANT_CONTINUE);
      this.#buf = await storeRdb(this.#store, gen, await this.#line(), this.#buf, () => this.#read());
      this.generation = { gen, replid, offset: Number(offset), master: replid, shift: Number(offset) };
      this.received = Number(offset);
    } else throw new Error(`expected FULLRESYNC or CONTINUE, got ${kind}`);

    const ack = () => this.#writer.write(command(["REPLCONF", "ACK", String(this.received)])).catch(noop);

    this.#ack = setInterval(() => void ack(), ACK_MS);
  }

  async #stream(): Promise<void> {
    const { gen } = this.generation;

    for (;;) {
      const part = this.#buf.length ? this.#buf : await this.#read();

      this.#buf = new Uint8Array(0);
      this.#store.append(gen, LOG, part.slice());
      this.received += part.length;
      this.#waiters = this.#waiters.filter((w) => (w.offset <= this.received ? (w.resolve(), false) : true));

      if (this.#catchUp && this.received >= this.#catchUp.other.received) {
        this.#catchUp.resolve();
        this.#catchUp = null;
      }
    }
  }

  // Master keepalives during an RDB transfer are bare newlines.
  async #line(): Promise<string> {
    for (;;) {
      while (this.#buf[0] === 10) this.#buf = this.#buf.subarray(1);

      const end = lineEnd(this.#buf, 0, this.#buf.length);

      if (end >= 0) {
        const line = str(this.#buf.subarray(0, end));

        this.#buf = this.#buf.subarray(end + 2);

        return line;
      }

      this.#buf = concat([this.#buf, await this.#read()]);
    }
  }

  async #read(): Promise<Uint8Array> {
    const { value, done } = await this.#reader.read();

    if (done) throw new Error("replication link closed");

    return value;
  }

  #break(e: Error, onBroken: (e: Error) => void): void {
    if (this.#closed) return; // closed on purpose
    this.broken = e;
    this.close();

    for (const w of this.#waiters) w.reject(e);
    this.#waiters = [];
    onBroken(e);
  }
}
