import { request } from "../protocol/request";
import { command, concat, elements, frameEnd, lower, num } from "../protocol/resp";
import { append } from "../router/buffer";
import { noop } from "../shared";

export const ROLE = command(["ROLE"]);

// Resolves once the replication stream up to an offset is stored, whichever link is current by then.
export type Fence = (offset: number) => Promise<void>;

const SUBSCRIBE = new Set(["subscribe", "psubscribe", "ssubscribe"]);

interface Batch {
  count: number;
  fenced: boolean; // ROLE follows the batch
  raw: boolean; // a subscribe: from here on, replies pass through as they come
}

// ROLE's reply is ["master", offset, replicas]: the offset after every command before it ran.
export function roleOffset(frame: Uint8Array): number {
  const offset = elements(frame)[1];

  if (offset?.[0] !== 58) throw new Error("ROLE: Redis isn't a master");

  return num(offset, 1, offset.length - 2);
}

// Replies leave only once the replication stream up to ROLE's offset is stored: a write is acknowledged once it's
// durable, and no read sees a write that isn't. Inside MULTI nothing has run yet, so EXEC's batch carries the fence.
export async function proxy(client: Socket, redis: Socket, fence: Fence, greeting: Uint8Array): Promise<void> {
  const toClient = client.writable.getWriter(),
    toRedis = redis.writable.getWriter(),
    batches: Batch[] = [];

  let inMulti = false,
    raw = false;

  const requests = async () => {
    const reader = client.readable.getReader();
    let buf: Uint8Array = new Uint8Array(0);

    for (;;) {
      const { value, done } = await reader.read();

      if (done) return;
      buf = append(buf, value);

      let i = 0,
        count = 0,
        subscribed = false;

      for (let r; (r = request(buf, i, buf.length)); i = r.end) {
        if (!r.argv.length) continue; // an empty inline line gets no reply
        count++;
        const name = lower(r.argv[0] ?? new Uint8Array(0));

        if (name === "multi") inMulti = true;
        else if (name === "exec" || name === "discard") inMulti = false;
        else if (SUBSCRIBE.has(name)) subscribed = true;
      }

      if (!count) continue;
      raw ||= subscribed;
      const fenced = !raw && !inMulti;

      batches.push({ count, fenced, raw });
      await toRedis.write(fenced ? concat([buf.subarray(0, i), ROLE]) : buf.slice(0, i));
      buf = buf.slice(i);
    }
  };

  const replies = async () => {
    const reader = redis.readable.getReader();

    let buf: Uint8Array = new Uint8Array(0),
      got: Uint8Array[] = [];

    for (;;) {
      const { value, done } = await reader.read();

      if (done) return;
      buf = append(buf, value);
      let start = 0;

      for (let e; (e = frameEnd(buf, start, buf.length)) >= 0; start = e) {
        const frame = buf.slice(start, e),
          batch = batches[0];

        if (!batch || batch.raw) {
          await toClient.write(frame);
          continue;
        }

        got.push(frame);

        if (got.length < batch.count + (batch.fenced ? 1 : 0)) continue;
        batches.shift();

        if (batch.fenced) {
          await fence(roleOffset(frame));
          got = got.slice(0, -1);
        }

        await toClient.write(concat(got));
        got = [];
      }

      buf = buf.slice(start);
    }
  };

  try {
    await toClient.write(greeting);
    await Promise.race([requests(), replies()]);
  } catch {
    // closing both tells the router the pending commands are lost
  } finally {
    client.close().catch(noop);
    redis.close().catch(noop);
  }
}
