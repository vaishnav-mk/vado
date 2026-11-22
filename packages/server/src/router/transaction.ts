// MULTI/WATCH: commands are queued here and sent to one shard at EXEC, on a socket of its own.
import { keyIndexes } from "../protocol/commands";
import { error } from "../protocol/resp";
import type { CommandEntry } from "../protocol/types";
import { NOT_IN_MULTI, PUBSUB, UNSUPPORTED } from "./command-sets";
import type { Conn } from "./conn";
import { shardAt, shardOfKeys } from "./key-shards";
import {
  arityError,
  CROSSSLOT,
  EXEC,
  EXECABORT,
  MULTI,
  NULL3,
  NULL_ARRAY,
  OK,
  QUEUED,
  UNWATCH,
  unsupported,
  wrongArity,
} from "./replies-text";
import { forward } from "./routing";
import type { Multi } from "./types";

const noop = () => {};

export function multi(c: Conn): void {
  if (c.tx.multi) return c.replies.reply(error("ERR MULTI calls can not be nested"));
  c.tx.multi = { cmds: [], shard: c.tx.watch, watched: c.tx.watch !== null, failed: false };
  c.replies.reply(OK);
}

// An error while queueing makes EXEC abort.
function refuse(c: Conn, m: Multi, reply: Uint8Array): void {
  m.failed = true;
  c.replies.reply(reply);
}

export function queue(
  c: Conn,
  m: Multi,
  name: string,
  entry: CommandEntry | undefined,
  argv: Uint8Array[],
  raw: Uint8Array,
): void {
  const bad = arityError(entry, name, argv);

  if (bad) return refuse(c, m, bad);

  if (PUBSUB.has(name) || UNSUPPORTED.has(name) || NOT_IN_MULTI.has(name))
    return refuse(c, m, unsupported(`${name} in MULTI`));
  const idx = keyIndexes(c.target.table, name, argv);

  if (idx === null) return refuse(c, m, unsupported(`${name} in MULTI`));

  if (idx.length && c.db.shards > 1) {
    const shard = shardAt(argv, idx, c.db.shards);

    if (shard < 0 || (m.shard !== null && m.shard !== shard)) return refuse(c, m, CROSSSLOT);
    m.shard = shard;
  }

  m.cmds.push(raw.slice());
  c.replies.reply(QUEUED);
}

export function exec(c: Conn): void {
  const m = c.tx.multi;

  if (!m) return c.replies.reply(error("ERR EXEC without MULTI"));
  c.tx.multi = null;

  const watchUp = c.tx.watchUp,
    broken = m.watched && (c.tx.watchBroken || !watchUp || watchUp.dead);

  c.tx.clearWatch();

  if (m.failed) return c.replies.reply(EXECABORT);

  if (broken) return c.replies.reply(c.proto === 3 ? NULL3 : NULL_ARRAY);

  const s = c.replies.slot(),
    shard = m.shard ?? 0;

  const send = () => {
    // A connection of its own: an RPC batch could end between MULTI and EXEC, on a pooled client.
    const up = m.watched && watchUp ? watchUp : c.pool.get(shard, true);
    c.writes.start(shard);
    up.send(MULTI, noop);

    for (const cmd of m.cmds) up.send(cmd, noop);
    up.send(EXEC, (f) => {
      c.writes.done(shard);
      c.replies.resolve(s, f);
    });
  };

  // Earlier requests to the shard by RPC have no order with a socket: run the transaction after them.
  if (!m.watched && c.pool.isRpc(shard)) c.replies.hold(c.replies.afterEarlier(s).then(send));
  else send();
}

export function discard(c: Conn): void {
  if (!c.tx.multi) return c.replies.reply(error("ERR DISCARD without MULTI"));
  c.tx.multi = null;

  if (c.tx.watch !== null && !c.tx.watchBroken) c.pool.get(c.tx.watch).send(UNWATCH, noop);
  c.tx.clearWatch();
  c.replies.reply(OK);
}

export function watch(c: Conn, argv: Uint8Array[], raw: Uint8Array): void {
  if (c.tx.multi) return c.replies.reply(error("ERR WATCH inside MULTI is not allowed"));

  if (argv.length < 2) return c.replies.reply(wrongArity("watch"));
  const shard = c.db.shards === 1 ? 0 : shardOfKeys(argv.slice(1), c.db.shards);

  if (shard < 0 || (c.tx.watch !== null && c.tx.watch !== shard)) return c.replies.reply(CROSSSLOT);
  c.tx.watch = shard;

  const s = c.replies.slot(),
    up = c.pool.get(shard, true);

  // earlier keys were watched on a connection that died
  if (c.tx.watchUp && c.tx.watchUp !== up) c.tx.watchBroken = true;
  c.tx.watchUp = up;
  up.send(raw, (f) => c.replies.resolve(s, f));
}

export function unwatch(c: Conn, raw: Uint8Array): void {
  const shard = c.tx.watch;

  if (shard === null || c.tx.watchBroken) {
    c.tx.clearWatch();

    return c.replies.reply(OK);
  }

  forward(c, shard, raw);
  c.tx.clearWatch();
}
