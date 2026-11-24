import { concat, frameEnd, lineEnd, lower } from "../protocol/resp";
import { RespClient } from "../protocol/resp-client";
import type { FrameResume, Reply } from "../protocol/types";
import { append } from "../protocol/bytes";
import { infoFields } from "../protocol/info";
import { failure, noop, sleep, text, withTimeout } from "../shared";
import { ASK_MS, POLL_MS, READY_MS, REPLAY_BATCH, REPLAY_STALL_MS } from "./config";
import type { Started } from "./types";

const SERVER_PORT = 6379;

export function containerOf(ctx: DurableObjectState): Container {
  if (!ctx.container) throw new Error("this object has no container");

  return ctx.container;
}

export const dial = (ctx: DurableObjectState, port = SERVER_PORT): Socket =>
  containerOf(ctx).getTcpPort(port).connect(`10.0.0.1:${port}`);

// One command on a connection of its own.
async function ask(ctx: DurableObjectState, cmd: string[]): Promise<Reply> {
  const socket = dial(ctx);

  await withTimeout(socket.opened, ASK_MS, "connecting");
  const client = new RespClient(socket, ASK_MS);

  try {
    const [reply = null] = await client.call(cmd);

    return reply;
  } finally {
    client.close();
  }
}

export async function ready(ctx: DurableObjectState, ms = READY_MS): Promise<void> {
  const deadline = Date.now() + ms;

  for (;;) {
    // LOADING until the RDB is in; nothing listening before the server starts.
    if (
      await ask(ctx, ["PING"]).then(
        (r) => failure(r) === null,
        () => false,
      )
    )
      return;

    if (Date.now() > deadline) throw new Error(`the server wasn't ready after ${ms / 1000} s`);
    await sleep(POLL_MS);
  }
}

// A plain client gets no reply to REPLCONF GETACK (sent after a WAIT); every other frame gets one.
const isReplconf = (frame: Uint8Array) => {
  const head = lineEnd(frame, 1, frame.length) + 2;

  return lower(frame.subarray(head, frameEnd(frame, head, frame.length))) === "$8\r\nreplconf\r\n";
};

// Stored rows can be a few bytes, so they go out REPLAY_BATCH at a time; `resume` scans a split frame once.
export async function replay(socket: Socket, chunks: Iterable<Uint8Array>): Promise<void> {
  await socket.opened;
  const client = new RespClient(socket, REPLAY_STALL_MS);

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
    drained.catch(noop); // awaited below
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

export async function historyOf(ctx: DurableObjectState): Promise<Started["history"]> {
  const info = text(await ask(ctx, ["INFO", "replication"]));
  const { master_replid: replid, master_repl_offset: offset } = infoFields(info);

  return replid && offset ? { replid, offset: Number(offset) } : null;
}
