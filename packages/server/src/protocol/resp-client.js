// A small RESP client over a socket ({ readable, writable }): pipelined calls, replies decoded by
// protocol/resp.js (bulk strings as strings, errors as { err }; or with their types, by decodeTyped). Used by the
// bench and the Admin API.
import { command, concat, decode, frameEnd } from "./resp.js";
import { connectLocal } from "../router/serve.js";

export class RespClient {
  #w; #r; #buf = new Uint8Array(0); #stallMs;

  constructor(socket, stallMs = 30_000) {
    this.#w = socket.writable.getWriter();
    this.#r = socket.readable.getReader();
    this.#stallMs = stallMs;
  }

  /** Sends every command at once, then reads one reply for each. */
  async call(...cmds) {
    await this.send(...cmds);
    return this.read(cmds.length);
  }

  /** Sends every command at once, without reading the replies. */
  send(...cmds) { return this.#w.write(concat(cmds.map(command))); }

  /** Reads the next `n` replies, each decoded by `parse` (resp.js decode or decodeTyped). A connection that sends
   *  nothing for stallMs is an error, not a hang. */
  async read(n, parse = decode) {
    const out = [];
    let pos = 0;
    while (out.length < n) {
      const end = frameEnd(this.#buf, pos, this.#buf.length);
      if (end >= 0) { out.push(parse(this.#buf.subarray(pos, end))[0]); pos = end; continue; }
      let timer;
      const stall = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`stalled ${this.#stallMs / 1000}s waiting for reply ${out.length + 1}/${n}`)), this.#stallMs); });
      const { value, done } = await Promise.race([this.#r.read(), stall]).finally(() => clearTimeout(timer));
      if (done) throw new Error(`connection closed after ${out.length}/${n} replies`);
      this.#buf = concat([this.#buf.subarray(pos), value]);
      pos = 0;
    }
    this.#buf = this.#buf.subarray(pos);
    return out;
  }

  close() { this.#w.close().catch(() => {}); }

  /** A connection to database `name` through a router in this isolate, signed in. */
  static async open(env, name, stallMs) {
    const c = new RespClient(connectLocal(env, name), stallMs);
    if (env.VALKEY_PASSWORD) {
      const [r] = await c.call(["AUTH", env.VALKEY_PASSWORD]);
      if (r?.err) { c.close(); throw new Error(`AUTH: ${r.err}`); }
    }
    return c;
  }
}
