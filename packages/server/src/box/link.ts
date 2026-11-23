import { command, concat, lineEnd, str } from "../protocol/resp";
import { encoder, noop } from "../shared";
import { BASE, LOG } from "./store";
import type { BoxStore, Generation } from "./store";

const CHUNK = 1 << 20;
const EOF_MARK = 40;
const ACK_MS = 1_000;

export const FENCE_MS = 15_000;

type Waiter = { offset: number; resolve: () => void; reject: (e: Error) => void };

// Where a stored stream can go on: the history to ask for and the offset of its last stored byte. `only`: a full copy
// from this server isn't trusted, so a refusal fails the link before any copy.
export interface Resume {
  from: Generation;
  replid: string;
  offset: number;
  only: boolean;
}

export const CANT_CONTINUE = "the server can't continue the stored stream";

// This object is a replica of the container's server. It stores the server's own replication stream: an RDB, then
// the effects of every write, which replay deterministically. `received` is the offset of the last byte written to
// storage; the output gate holds anything this object sends afterwards until those writes commit.
export class ReplicaLink {
  received = 0;
  broken: Error | null = null;
  generation: Generation = { gen: 0, replid: "", offset: 0 };
  continued = false; // the stream went on into the stored generation: no new copy
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #store: BoxStore;
  readonly #socket: Socket;
  #buf: Uint8Array = new Uint8Array(0);
  #waiters: Waiter[] = [];
  #ack: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  #catchUp: { other: ReplicaLink; resolve: () => void } | null = null;

  private constructor(socket: Socket, store: BoxStore) {
    this.#socket = socket;
    this.#reader = socket.readable.getReader();
    this.#writer = socket.writable.getWriter();
    this.#store = store;
  }

  // Resolves with the stream running: continued from `resume` when the server still has it, else after a full copy
  // stored as generation `gen`. The caller makes the link's generation current.
  static async open(
    socket: Socket,
    store: BoxStore,
    gen: number,
    resume: Resume | null,
    onBroken: (e: Error) => void,
  ): Promise<ReplicaLink> {
    const link = new ReplicaLink(socket, store);

    await link.#sync(gen, resume);
    void link.#stream().catch((e: Error) => link.#break(e, onBroken));

    return link;
  }

  // The offset ROLE reported, once its stream bytes are stored.
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

  // Once this link has stored everything `other` has, its generation holds every acknowledged write.
  caughtUp(other: ReplicaLink): Promise<void> {
    if (this.received >= other.received) return Promise.resolve();

    return new Promise((resolve) => {
      this.#catchUp = { other, resolve };
    });
  }

  // Waiters move to the link that replaces this one: both are replicas of one master, so offsets mean the same.
  handOver(next: ReplicaLink): void {
    for (const w of this.#waiters) next.reached(w.offset, FENCE_MS).then(w.resolve, w.reject);
    this.#waiters = [];
    this.close();
  }

  close(): void {
    this.#closed = true;

    if (this.#ack) clearInterval(this.#ack);
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
      await this.#rdb(gen, await this.#line());
      this.generation = { gen, replid, offset: Number(offset), master: replid, shift: Number(offset) };
      this.received = Number(offset);
    } else throw new Error(`expected FULLRESYNC or CONTINUE, got ${kind}`);

    this.#ack = setInterval(() => void this.#sendAck(), ACK_MS);
  }

  // "$<len>" or, diskless, "$EOF:<40 bytes>" with the same 40 bytes after the payload.
  async #rdb(gen: number, header: string): Promise<void> {
    const mark = header.startsWith("$EOF:") ? encoder.encode(header.slice(5)) : null;
    let left = mark ? Infinity : Number(header.slice(1));

    let pending: Uint8Array[] = [],
      size = 0,
      tail: Uint8Array = new Uint8Array(0);

    const flush = (keep: number) => {
      const all = concat(pending);

      for (let i = 0; i + keep < all.length; i += CHUNK)
        this.#store.append(gen, BASE, all.slice(i, Math.min(i + CHUNK, all.length - keep)));
      pending = keep ? [all.slice(all.length - keep)] : [];
      size = keep ? Math.min(keep, all.length) : 0;
    };

    while (left > 0) {
      const part = this.#buf.length ? this.#buf : await this.#read();
      const take = mark ? part.length : Math.min(left, part.length);

      pending.push(part.subarray(0, take));
      size += take;
      this.#buf = part.subarray(take);
      left -= take;

      if (mark) {
        tail = concat([tail, part.subarray(0, take)]).subarray(-EOF_MARK);

        if (tail.length === EOF_MARK && tail.every((b, i) => b === mark[i])) {
          flush(EOF_MARK);

          return;
        }
      }

      if (size >= CHUNK + EOF_MARK) flush(mark ? EOF_MARK : 0);
    }

    flush(0);
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

  #sendAck(): Promise<void> {
    return this.#writer.write(command(["REPLCONF", "ACK", String(this.received)])).catch(noop);
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
    if (this.#closed) return; // closed on purpose: replaced by a compaction, or shut down idle
    this.broken = e;
    this.close();

    for (const w of this.#waiters) w.reject(e);
    this.#waiters = [];
    onBroken(e);
  }
}
