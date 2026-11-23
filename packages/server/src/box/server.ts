import { concat, frameEnd, lineEnd, lower } from "../protocol/resp";
import type { FrameResume } from "../protocol/types";
import { RespClient } from "../protocol/resp-client";
import { append } from "../router/buffer";
import { infoFields } from "../shard/info";
import { failure, noop, sleep, text, withTimeout } from "../shared";
import type { Started } from "./container";

// Reaching a shard's container and the server in it, beyond the client traffic proxy.ts and mux.ts carry.

const PORT = 6379;

const READY_MS = 300_000;

const REPLAY_BATCH = 1 << 20;

export function containerOf(ctx: DurableObjectState): Container {
  if (!ctx.container) throw new Error("this object has no container");

  return ctx.container;
}

export const dial = (ctx: DurableObjectState): Socket => containerOf(ctx).getTcpPort(PORT).connect(`10.0.0.1:${PORT}`);

export async function ready(ctx: DurableObjectState, ms = READY_MS): Promise<void> {
  const deadline = Date.now() + ms;

  for (;;) {
    try {
      const socket = dial(ctx);

      await withTimeout(socket.opened, 5_000, "connecting");
      const client = new RespClient(socket, 5_000);
      const [pong = null] = await client.call(["PING"]);

      client.close();

      if (failure(pong) === null) return; // LOADING until the RDB is in
    } catch {
      // not listening yet
    }

    if (Date.now() > deadline) throw new Error(`the server wasn't ready after ${ms / 1000} s`);
    await sleep(50);
  }
}

// The stored stream is the server's own effects (SELECT, writes, PEXPIREAT, MULTI/EXEC), so it replays as plain
// commands. Every frame gets a reply nobody reads, except REPLCONF GETACK (after a WAIT): a plain client gets none.
const isReplconf = (frame: Uint8Array) => {
  const head = lineEnd(frame, 1, frame.length) + 2;

  return lower(frame.subarray(head, frameEnd(frame, head, frame.length))) === "$8\r\nreplconf\r\n";
};

// The stream is stored as it arrived, often in rows of a few bytes: sent a megabyte at a time, with each batch's
// replies drained behind it so they never pile up. A frame split over many rows is scanned once (`resume`), never
// copied, so a big value costs its own size.
export async function replay(socket: Socket, chunks: Iterable<Uint8Array>): Promise<void> {
  await socket.opened;
  const client = new RespClient(socket, 60_000);

  let carry: Uint8Array = new Uint8Array(0),
    resume: FrameResume = {},
    batch: Uint8Array[] = [],
    size = 0,
    owed = 0,
    drained: Promise<unknown> = Promise.resolve();

  const send = async () => {
    const replies = owed;

    await client.sendRaw(concat(batch));
    drained = drained.then(() => client.read(replies, () => [0, 0]));
    drained.catch(noop); // awaited at the end; a failed send must not leave it unhandled
    [batch, size, owed] = [[], 0, 0];
  };

  for (const chunk of chunks) {
    carry = append(carry, chunk);
    let start = 0;

    for (let e; (e = frameEnd(carry, start, carry.length, resume)) >= 0; start = e) {
      resume = {};

      if (!isReplconf(carry.subarray(start, e))) owed++;
    }

    carry = carry.subarray(start);
    batch.push(chunk);
    size += chunk.length;

    if (size >= REPLAY_BATCH) await send();
  }

  await send();
  await drained;
  client.close();
}

// The server's replication history and offset now: where its stream goes on.
export async function historyOf(ctx: DurableObjectState): Promise<Started["history"]> {
  const socket = dial(ctx);

  await socket.opened;
  const client = new RespClient(socket, 5_000);
  const [info = null] = await client.call(["INFO", "replication"]);

  client.close();
  const { master_replid: replid, master_repl_offset: offset } = infoFields(text(info));

  return replid && offset ? { replid, offset: Number(offset) } : null;
}
