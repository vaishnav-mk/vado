import { decode } from "../protocol/decode";
import { arrayOf, bulk, concat, integer, lower, str, TYPE } from "../protocol/resp";
import { PUBSUB, SUBSCRIBE, WHILE_SUBSCRIBED } from "./command-sets";
import type { Conn } from "./conn";
import { notWhileSubscribed, OK } from "./replies-text";
import type { Upstream } from "./types";

export function pubsub(c: Conn, name: string, argv: Uint8Array[], raw: Uint8Array): void {
  const unsubscribe = name.endsWith("unsubscribe");

  if (!SUBSCRIBE.has(name) && !unsubscribe) {
    const s = c.replies.slot();

    return c.pool.get("pubsub").send(raw, (f) => c.replies.resolve(s, f));
  }

  const up = c.pool.get("pubsub");

  // Confirmations and messages arrive as pushes.
  if (c.proto === 3) return up.raw(raw.slice());

  // Not subscribed: Valkey answers once per channel named, or once if none is.
  if (unsubscribe) {
    const channels = argv.length > 1 ? argv.slice(1) : [null];

    return c.replies.reply(concat(channels.map((ch) => arrayOf([bulk(name), bulk(ch), integer(0)]))));
  }

  c.pass = up;
  up.passthrough = (f) => passed(c, f);
  up.raw(raw.slice());
}

function passed(c: Conn, f: Uint8Array): void {
  c.push(f);

  if (f[0] === TYPE.simple && str(f).startsWith("+RESET")) return c.endPassthrough(false);

  if (f[0] !== 42) return;
  const [v] = decode(f);

  // Not only pushes: RESP3 subscribers run other commands too, whose replies can start with null or a number.
  if (Array.isArray(v) && !(v[0] instanceof Object) && String(v[0]).endsWith("unsubscribe") && v[2] === 0)
    c.endPassthrough(false);
}

export function passRequest(c: Conn, pass: Upstream, argv: Uint8Array[], raw: Uint8Array): void {
  const name = lower(argv[0]);

  if (!PUBSUB.has(name) && !WHILE_SUBSCRIBED.has(name)) return c.push(notWhileSubscribed(name));

  if (name === "quit") {
    c.push(OK);

    return c.close();
  }

  pass.raw(raw.slice());
}
