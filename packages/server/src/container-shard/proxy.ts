import { request } from "../protocol/request";
import { concat, frameEnd, lower } from "../protocol/resp";
import type { FrameResume, RequestResume } from "../protocol/types";
import { append } from "../protocol/bytes";
import { SUBSCRIBE } from "../protocol/commands";
import { noop } from "../shared";
import { ROLE, roleOffset } from "./link";
import type { Fence, ProxyBatch } from "./types";

// Inside MULTI nothing has run yet, so EXEC's batch carries the fence.
export async function proxy(client: Socket, server: Socket, fence: Fence, greeting: Uint8Array): Promise<void> {
  const toClient = client.writable.getWriter(),
    toServer = server.writable.getWriter(),
    batches: ProxyBatch[] = [];

  let inMulti = false,
    raw = false;

  const requests = async () => {
    const reader = client.readable.getReader(),
      parsing: RequestResume = {};

    let buf: Uint8Array = new Uint8Array(0);

    for (;;) {
      const { value, done } = await reader.read();

      if (done) return;
      buf = append(buf, value);

      let i = 0,
        count = 0,
        subscribed = false;

      for (let r; (r = request(buf, i, buf.length, Infinity, parsing)); i = r.end) {
        if (!r.argv.length) continue; // an empty inline line gets no reply
        count++;
        const name = lower(r.argv[0]);

        if (name === "multi") inMulti = true;
        else if (name === "exec" || name === "discard") inMulti = false;
        else if (SUBSCRIBE.has(name)) subscribed = true;
      }

      if (!count) continue;
      raw ||= subscribed;
      const fenced = !raw && !inMulti;

      batches.push({ count, fenced, raw });
      await toServer.write(fenced ? concat([buf.subarray(0, i), ROLE]) : buf.slice(0, i));
      buf = buf.subarray(i);
    }
  };

  const replies = async () => {
    const reader = server.readable.getReader(),
      part: FrameResume = {};

    let buf: Uint8Array = new Uint8Array(0),
      start = 0,
      got: Uint8Array[] = [];

    for (;;) {
      const { value, done } = await reader.read();

      if (done) return;
      buf = append(buf.subarray(start), value);
      start = 0;

      for (let e; (e = frameEnd(buf, start, buf.length, part)) >= 0; start = e) {
        const batch = batches[0];

        if (!batch || batch.raw) {
          await toClient.write(buf.slice(start, e));
          continue;
        }

        // A view: append never rewrites bytes it handed out, and concat below copies them.
        const frame = buf.subarray(start, e);

        got.push(frame);

        if (got.length < batch.count + (batch.fenced ? 1 : 0)) continue;
        batches.shift();

        if (batch.fenced) {
          await fence(roleOffset(frame)).catch((e: Error) => {
            console.log(`fence: ${e.message}`);
            throw e;
          });
          got.pop();
        }

        await toClient.write(concat(got));
        got = [];
      }
    }
  };

  try {
    await toClient.write(greeting);
    await Promise.race([requests(), replies()]);
  } catch {
    // closing both tells the router the pending commands are lost
  } finally {
    client.close().catch(noop);
    server.close().catch(noop);
  }
}
