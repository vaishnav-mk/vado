import { sameBytes } from "../protocol/bytes";
import { SUBSCRIBE } from "../protocol/commands";
import { arrayOf, bulk, bulkText, concat, elements, EMPTY, lower } from "../protocol/resp";
import { PUBSUB, WHILE_SUBSCRIBED } from "./command-sets";
import type { Conn } from "./conn";
import { notWhileSubscribed, OK, RESET, ZERO } from "./replies-text";
import type { Upstream } from "./types";
import { resetState } from "./session";

export function pubsub(c: Conn, name: string, argv: Uint8Array[], raw: Uint8Array): void {
  const unsubscribe = name.endsWith("unsubscribe");

  if (!SUBSCRIBE.has(name) && !unsubscribe) {
    const s = c.replies.slot();

    return c.pool.get("pubsub").send(raw, (f) => c.replies.resolve(s, f));
  }

  // Confirmations and messages arrive as pushes.
  if (c.proto === 3) return c.pool.get("pubsub").raw(raw);

  // Not subscribed: Valkey answers once per channel named, or once if none is.
  if (unsubscribe) {
    const channels = argv.length > 1 ? argv.slice(1) : [null];

    return c.replies.reply(concat(channels.map((ch) => arrayOf([bulk(name), bulk(ch), ZERO]))));
  }

  const up = c.pool.get("pubsub");
  c.pass = up;
  up.passthrough = (f) => passed(c, f);
  up.raw(raw);
}

// Passthrough ends at RESET, or at an unsubscribe confirmation that leaves no subscriptions.
function passed(c: Conn, f: Uint8Array): void {
  c.push(f);

  // A RESET that went to the subscribed connection resets the rest of the session too.
  if (sameBytes(f, RESET)) return resetState(c);

  if (f[0] !== 42) return;
  const [kind, , count = EMPTY] = elements(f);

  if (sameBytes(count, ZERO) && bulkText(kind).endsWith("unsubscribe")) c.endPassthrough(false);
}

export function passRequest(c: Conn, pass: Upstream, argv: Uint8Array[], raw: Uint8Array): void {
  const name = lower(argv[0]);

  if (!PUBSUB.has(name) && !WHILE_SUBSCRIBED.has(name)) return c.push(notWhileSubscribed(name));

  if (name === "quit") {
    c.push(OK);

    return c.close();
  }

  pass.raw(raw);
}
