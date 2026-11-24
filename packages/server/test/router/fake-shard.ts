import type { DatabaseRecord } from "../../src/catalog/types";
import { commandTable } from "../../src/protocol/commands";
import { decodeAll } from "../../src/protocol/decode";
import { command } from "../../src/protocol/resp";
import { Router } from "../../src/router/router";
import { socketPair } from "../../src/router/socket-pair";
import type { ShardStub } from "../../src/router/types";
import { noop } from "../../src/shared";

const enc = new TextEncoder(),
  dec = new TextDecoder();

export const bulkOf = (s: string) => `$${s.length}\r\n${s}\r\n`;

// A shard socket: a greeting, then `answer` for each request read; `send` writes frames nobody asked for.
export function fakeShard(answer: (argv: string[]) => string) {
  const got: string[][] = [];

  let out: WritableStreamDefaultWriter<Uint8Array> | null = null,
    connects = 0;

  async function serve(readable: ReadableStream<Uint8Array>): Promise<void> {
    const reader = readable.getReader();

    for (;;) {
      const { value, done } = await reader.read();

      if (done) return;

      for (const r of decodeAll(value)) {
        const argv = Array.isArray(r) ? r.map(String) : [];
        got.push(argv);
        await out?.write(enc.encode(answer(argv)));
      }
    }
  }

  const connect = (_address: string): Socket => {
    const [mine, theirs] = socketPair();
    connects++;
    out = theirs.writable.getWriter();
    void out.write(enc.encode("+instance\r\n"));
    void serve(theirs.readable);

    // SAFETY: a router only reads, writes and closes its shard sockets.
    return { ...mine, close: () => Promise.resolve() } as Socket;
  };

  return {
    // SAFETY: a router calls only connect() on a shard it reaches by socket.
    stub: { connect } as ShardStub,
    got,
    connects: () => connects,
    send: (frames: string) => out?.write(enc.encode(frames)),
  };
}

const table = commandTable([
  ["mget", -2, ["readonly"], 1, -1, 1, [], [], [], []],
  ["set", -3, ["write"], 1, 1, 1, [], [], [], []],
  ["watch", -2, [], 1, -1, 1, [], [], [], []],
  ["multi", 1, [], 0, 0, 0, [], [], [], []],
  ["exec", 1, [], 0, 0, 0, [], [], [], []],
  ["discard", 1, [], 0, 0, 0, [], [], [], []],
  ["unwatch", 1, [], 0, 0, 0, [], [], [], []],
  ["keys", 2, ["readonly"], 0, 0, 0, [], [], [], []],
  ["get", 2, ["readonly"], 1, 1, 1, [], [], [], []],
  ["scan", -2, ["readonly"], 0, 0, 0, [], [], [], []],
  ["randomkey", 1, ["readonly"], 0, 0, 0, [], [], [], []],
]);

// A RESP2 client on a router over these shards, no password.
export function client(shards: ShardStub[], pubsub: ShardStub) {
  const [mine, theirs] = socketPair();

  const db: DatabaseRecord = {
    name: "db",
    created: 0,
    shards: shards.length,
    regions: null,
    replicas: null,
    classes: null,
    secret: null,
    flavour: "valkey",
  };

  const router = new Router(
    theirs,
    { db, table, shard: (i) => shards[i], pubsub: () => pubsub, replica: () => null },
    {
      password: undefined,
      trusted: false,
      lookup: () => Promise.resolve(null),
      open: () => Promise.reject(new Error("no other database")),
      onDropped: noop,
      signIns: null,
      idleMs: 30_000,
      dial: "test",
    },
  );

  const running = router.run(),
    writer = mine.writable.getWriter(),
    reader = mine.readable.getReader();

  let text = "";

  return {
    call: (...args: string[]) => writer.write(command(args)),
    send: (bytes: Uint8Array) => writer.write(bytes),
    // The next `n` characters the router writes.
    async read(n: number): Promise<string> {
      while (text.length < n) {
        const { value, done } = await reader.read();

        if (done) break;
        text += dec.decode(value);
      }

      const head = text.slice(0, n);
      text = text.slice(n);

      return head;
    },
    async close(): Promise<void> {
      await writer.close();
      await running;
    },
  };
}
