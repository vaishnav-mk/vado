// The bytes a primary sends its replicas, and what comes back. Old primaries stream to new replicas: keep them.
import { command, concat } from "../protocol/resp";

const REPLY_OFF = command(["CLIENT", "REPLY", "OFF"]);

/** With replies off, only "+OK" then "+PONG" come back for this, once the replica has run everything before it. */
export const MARK = concat([
  command(["CLIENT", "REPLY", "ON"]),
  command(["PING"]),
  command(["CLIENT", "REPLY", "OFF"]),
]);

// The stream's connection is the import source (replicas run with import-mode): to it no key is ever expired.
// Redis lacks the command (its import-mode treats every write as the stream's); with replies off the error is unseen.
export const START = concat([REPLY_OFF, command(["CLIENT", "IMPORT-SOURCE", "ON"]), command(["FLUSHALL"])]);

export const COPY_CHUNK = 1 << 20;

const PONG = "+PONG\r\n";

/** Counts the "+PONG" replies in a replica's bytes, however they are split. */
export class PongCounter {
  #carry = "";
  #decoder = new TextDecoder();

  count(bytes: Uint8Array): number {
    const text = this.#carry + this.#decoder.decode(bytes, { stream: true });
    let n = 0;
    let at = 0;

    for (let i = text.indexOf(PONG); i >= 0; i = text.indexOf(PONG, at)) {
      n++;
      at = i + PONG.length;
    }

    this.#carry = text.slice(Math.max(at, text.length - (PONG.length - 1)));

    return n;
  }
}
