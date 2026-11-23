import { frameEnd } from "../protocol/resp";
import type { FrameResume } from "../protocol/types";
import { append } from "./buffer";
import { noop } from "../shared";

/**
 * Calls `frame` with each whole RESP frame `socket` sends, while `current()` holds. Resolves once the socket ends or
 * fails (a reset, a protocol error), or, cancelling it, once `current()` stops holding.
 */
export async function readFrames(
  socket: Socket,
  current: () => boolean,
  frame: (f: Uint8Array) => void,
): Promise<void> {
  const reader = socket.readable.getReader(),
    // how far frameEnd() got into a reply that is still arriving
    part: FrameResume = {};

  let buf: Uint8Array = new Uint8Array(0),
    start = 0;

  try {
    for (;;) {
      const { value, done } = await reader.read();

      if (done) return;

      if (!current()) return void reader.cancel().catch(noop);
      buf = start < buf.length ? append(buf.subarray(start), value) : value;
      start = 0;

      for (let e; current() && (e = frameEnd(buf, start, buf.length, part)) >= 0; start = e) frame(buf.slice(start, e));
    }
  } catch {
    // the caller decides what a closed socket means
  }
}
