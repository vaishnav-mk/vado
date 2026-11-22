// Pooled internal Valkey clients for RPC batches. Reusing them avoids an accept, create, QUIT and free per batch,
// which saturated shards when hundreds of routers sent batches at once. Commands that leave connection state behind
// (WATCH, SUBSCRIBE, CLIENT REPLY) never come through here.
import { frameEnd } from "../../protocol/resp";
import { POOL_MAX } from "./config";
import { Gauge } from "./gauge";
import type { Loop } from "./loop";
import type { Sockets } from "./sockets";
import type { PooledClient, Protocol } from "./types";

const encoder = new TextEncoder();
const QUIT = encoder.encode("*1\r\n$4\r\nQUIT\r\n");
const HELLO3 = encoder.encode("*2\r\n$5\r\nHELLO\r\n$1\r\n3\r\n");
const EMPTY = new Uint8Array(0);
const WRITTEN = Promise.resolve();
const PUSH = 62; // ">": RESP3 pushes aren't replies

/** Appends `bytes` to the client's reply buffer (doubling it when full) and counts the replies now complete. */
export function received(c: PooledClient, bytes: Uint8Array): void {
  if (c.len + bytes.length > c.out.length) {
    if (!c.len) c.out = bytes;
    else {
      const out = new Uint8Array(Math.max(c.out.length * 2, c.len + bytes.length));
      out.set(c.out.subarray(0, c.len));
      out.set(bytes, c.len);
      c.out = out;
    }
  } else c.out.set(bytes, c.len);
  c.len += bytes.length;

  for (let e; c.frames < c.want && (e = frameEnd(c.out, c.pos, c.len, c.resume)) >= 0; c.pos = e) {
    if (c.out[c.pos] !== PUSH) c.frames++;
  }
}

function reset(c: PooledClient, want: number): void {
  c.out = EMPTY;
  c.len = 0;
  c.pos = 0;
  c.frames = 0;
  c.want = want;
  c.resume.k = 0;
}

export class Internal {
  readonly batches = new Gauge(); // RPC batches running: their writes could wake a blocked client
  readonly #pool: Record<Protocol, PooledClient[]> = { 2: [], 3: [] };
  readonly #sockets: Sockets;
  readonly #loop: Loop;

  constructor(sockets: Sockets, loop: Loop) {
    this.#sockets = sockets;
    this.#loop = loop;
  }

  get pooled(): number {
    return this.#pool[2].length + this.#pool[3].length;
  }

  /** Runs `bytes` (exactly `count` commands) on a pooled client and returns their `count` replies. */
  async execBatch(bytes: Uint8Array, count: number, proto: Protocol): Promise<Uint8Array> {
    const c = this.#pool[proto].pop() ?? (await this.#client(proto));
    const out = await this.#batch(c, bytes, count);

    if (c.alive && this.#pool[proto].length < POOL_MAX) this.#pool[proto].push(c);
    else if (c.alive) {
      c.alive = false;
      c.socket.chunks.push(QUIT);
      this.#loop.schedule();
    }

    return out;
  }

  async #client(proto: Protocol): Promise<PooledClient> {
    const writer = {
      write: (bytes: Uint8Array) => {
        received(c, bytes);

        return WRITTEN;
      },
      close: () => WRITTEN,
    };

    const c: PooledClient = {
      alive: true,
      socket: this.#sockets.add(writer, true),
      out: EMPTY,
      len: 0,
      pos: 0,
      frames: 0,
      want: 0,
      resume: { k: 0, rel: 0 },
    };

    void c.socket.closed.promise.then(() => {
      c.alive = false;
    });

    if (proto === 3) await this.#batch(c, HELLO3, 1);

    return c;
  }

  async #batch(c: PooledClient, bytes: Uint8Array, count: number): Promise<Uint8Array> {
    this.batches.up();

    try {
      reset(c, count);
      c.socket.chunks.push(bytes);
      await this.#loop.stepUntil(() => c.frames >= c.want || !c.alive);
      const replies = c.out.subarray(0, c.pos); // cut short if the client closed
      reset(c, 0); // an idle pooled client keeps no reply buffer

      return replies;
    } finally {
      this.batches.down();
    }
  }
}
