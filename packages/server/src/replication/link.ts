// One replica of a primary: its socket, what is queued or unacknowledged on it, and its markers.
import type { Hint } from "../catalog/types";
import { concat } from "../protocol/resp";
import { REPL_BACKLOG, REPL_RETRY_MS } from "./config";
import type { Mark, ReplicaPhase, ReplicaStatus, ReplicaStub, ReplicatorHost } from "./types";
import { MARK, PongCounter } from "./wire";
import { messageOf } from "../shared";

export class ReplicaLink {
  readonly region: Hint;
  phase: ReplicaPhase = "idle";
  retryAt = 0;
  since = 0;
  /** Bytes queued while copying. */
  queued = 0;
  /** Bytes sent but not yet written to the socket. */
  inflight = 0;
  marks: Mark[] = [];
  /** WAITs that started before it was live. */
  waiting: (() => void)[] = [];
  ready = false;
  lagMs: number | null = null;
  colo: string | null = null;
  error: string | null = null;
  stub: ReplicaStub | null = null;
  #queue: Uint8Array[] = [];
  #socket: Socket | null = null;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #out: Uint8Array[] = [];
  #writing = false;
  #host: Pick<ReplicatorHost, "hold" | "release">;
  #label: string;

  constructor(region: Hint, host: Pick<ReplicatorHost, "hold" | "release">, primary: string) {
    this.region = region;
    this.#host = host;
    this.#label = `${primary} -> ${region}`;
  }

  status(asleep: boolean): ReplicaStatus {
    const live = this.ready ? "ready" : "catching up";

    return {
      region: this.region,
      state: asleep ? "asleep" : this.phase === "live" ? live : this.phase,
      lagMs: this.lagMs,
      colo: this.colo,
      behindBytes: this.phase === "live" ? this.inflight : this.queued,
      error: this.error,
    };
  }

  log(what: string): void {
    console.log(`replica ${this.#label} ${what}`);
  }

  startCopy(): void {
    this.phase = "copying";
    this.since = Date.now();
    this.#clear();
    this.error = null;
  }

  /** An append during the copy: sent once the files are. */
  enqueue(bytes: Uint8Array): void {
    this.#queue.push(bytes);
    this.queued += bytes.length;
    this.#host.hold(bytes.length);

    if (this.queued > REPL_BACKLOG) this.drop("fell too far behind while copying");
  }

  /** Appends queued before the copy took its file sizes are in the files. */
  discardQueue(): void {
    this.#host.release(this.queued);
    this.#queue = [];
    this.queued = 0;
  }

  /** The next queued append while the copy goes on. */
  nextQueued(): Uint8Array | undefined {
    const bytes = this.phase === "copying" ? this.#queue.shift() : undefined;

    if (bytes) {
      this.queued -= bytes.length;
      this.#host.release(bytes.length);
    }

    return bytes;
  }

  /** Dials the replica, starts reading its markers, and returns the stream's writer. */
  open(stub: ReplicaStub, dial: string): WritableStreamDefaultWriter<Uint8Array> {
    const socket = stub.connect(dial);
    const writer: WritableStreamDefaultWriter<Uint8Array> = socket.writable.getWriter();
    this.stub = stub;
    this.#socket = socket;
    this.#writer = writer;
    void this.#readMarks(socket);

    return writer;
  }

  // Nothing was awaited since the queue emptied, so no append is missed.
  goLive(): void {
    this.phase = "live";
    const waiting = this.waiting.splice(0);

    if (waiting.length) this.mark({ at: Date.now(), onAck: () => waiting.forEach((f) => f()) });
  }

  mark(mark: Mark): void {
    this.marks.push(mark);
    this.send(MARK);
  }

  // One socket write at a time: each waits for the output gate and a turn of the event loop, so appends that arrive
  // meanwhile go out together as one write.
  send(bytes: Uint8Array): void {
    this.inflight += bytes.length;
    this.#host.hold(bytes.length);

    if (this.inflight > REPL_BACKLOG) return this.drop("fell too far behind");
    this.#out.push(bytes);

    if (!this.#writing) this.#pump();
  }

  #pump(): void {
    const writer = this.#writer;

    if (!writer) return;
    const out = this.#out.length === 1 ? this.#out[0] : concat(this.#out);
    this.#out = [];
    this.#writing = true;
    writer.write(out).then(
      () => {
        if (this.#writer !== writer) return;
        this.inflight -= out.length;
        this.#host.release(out.length);
        this.#writing = false;

        if (this.#out.length) this.#pump();
      },
      (e) => this.drop(`socket: ${messageOf(e)}`),
    );
  }

  // Each "+PONG" answers the oldest marker. The first after the copy makes the replica serve reads.
  async #readMarks(socket: Socket): Promise<void> {
    const reader = socket.readable.getReader();
    const pongs = new PongCounter();

    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (done || this.#socket !== socket) break;

        for (let n = pongs.count(value); n > 0; n--) await this.#answered();
      }
    } catch {
      // The socket closed.
    }

    // It's gone already: no need to tell it.
    if (this.#socket === socket) this.drop("replica closed the connection", false);
  }

  async #answered(): Promise<void> {
    const mark = this.marks.shift();

    if (!mark) return;
    this.lagMs = Date.now() - mark.at;
    mark.onAck?.();

    if (mark.ready && this.stub)
      this.colo = await this.stub.replicaReady().then(
        (colo) => {
          this.ready = true;

          return colo;
        },
        () => null,
      );
  }

  drop(why: string, tell = true): void {
    if (this.phase === "idle") return;

    // A close from this end doesn't reach the replica, so tell it: it must not serve data that stopped updating.
    if (tell) this.stub?.retire().catch(() => {});
    this.#writer?.abort(why).catch(() => {});
    this.#socket?.close().catch(() => {});
    this.#host.release(this.inflight + this.queued);
    this.phase = "idle";
    this.#socket = null;
    this.#writer = null;
    this.#clear();
    this.waiting = [];
    this.error = why;
    this.retryAt = Date.now() + REPL_RETRY_MS;
    this.log(`dropped: ${why}`);
  }

  #clear(): void {
    this.#queue = [];
    this.queued = 0;
    this.inflight = 0;
    this.#out = [];
    this.#writing = false;
    this.marks = [];
    this.ready = false;
  }
}
