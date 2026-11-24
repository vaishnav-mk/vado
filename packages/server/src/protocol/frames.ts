import { frameEnd } from "./resp";
import type { FrameResume } from "./types";
import { append } from "./bytes";
import { noop } from "../shared";

export async function readFrames(
  socket: Socket,
  current: () => boolean,
  frame: (f: Uint8Array) => void,
): Promise<void> {
  const reader = socket.readable.getReader(),
    part: FrameResume = {};

  let buf: Uint8Array = new Uint8Array(0),
    start = 0;

  try {
    for (;;) {
      const { value, done } = await reader.read();

      if (done) return;

      if (!current()) return void reader.cancel().catch(noop);
      buf = append(buf.subarray(start), value);
      start = 0;

      for (let e; current() && (e = frameEnd(buf, start, buf.length, part)) >= 0; start = e) frame(buf.slice(start, e));
    }
  } catch {
    // the caller decides what a closed socket means
  }
}
