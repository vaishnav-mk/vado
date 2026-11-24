import { elements, isError, str } from "../protocol/resp";
import type { CommandEntry } from "../protocol/types";
import type { Conn } from "./conn";
import { replicaFailed, replicaResting } from "./isolate";
import { shardAt, shardOfKeys } from "./key-shards";
import type { Slot } from "./replies";
import { bulkBytes, CROSSSLOT, LOST } from "./replies-text";
import { split } from "./split";
import type { UpKey } from "./types";

// May go to a replica, and again to the primary if that fails.
const retryable = (c: Conn, entry: CommandEntry) =>
  entry.flags.has("readonly") && !entry.flags.has("blocking") && !c.tx.pinned;

// A blocking command gets a socket: on a shared RPC connection it would hold up everyone else's batches.
export function forward(
  c: Conn,
  shard: number,
  raw: Uint8Array,
  retry = false,
  s: Slot = c.replies.slot(),
  blocking = false,
): void {
  const copy = retry ? raw.slice() : null;
  let from: UpKey = shard;

  if (retry) from = readFrom(c, shard);
  else c.writes.start(shard);
  c.pool.get(from, blocking).send(raw, (f) => {
    if (!retry) c.writes.done(shard);

    if (f === LOST && copy) {
      if (from !== shard) replicaFailed(c.db.name, shard);

      return c.pool.get(shard).send(copy, (g) => c.replies.resolve(s, g));
    }

    c.replies.resolve(s, f);
  });
}

function readFrom(c: Conn, shard: number): UpKey {
  if (!c.db.replicas || c.tx.pinned) return shard;

  if (c.writes.recent(shard, c.now) || replicaResting(c.db.name, shard, c.now)) return shard;
  const key: UpKey = `r${shard}`;

  return c.pool.has(key) || c.target.replica(shard) ? key : shard;
}

export function routeKeys(
  c: Conn,
  name: string,
  entry: CommandEntry,
  argv: Uint8Array[],
  raw: Uint8Array,
  idx: number[],
): void {
  const shard = shardAt(argv, idx, c.db.shards);

  if (shard >= 0) return forward(c, shard, raw, retryable(c, entry), c.replies.slot(), entry.flags.has("blocking"));

  if (!split(c, name, argv)) c.replies.reply(CROSSSLOT);
}

export function getkeys(c: Conn, entry: CommandEntry, argv: Uint8Array[], raw: Uint8Array): void {
  const s = c.replies.slot(),
    copy = raw.slice(),
    target = c.target;

  // Later requests wait until this one is sent, so it runs before them on its shard.
  c.replies.hold(
    target
      .shard(0)
      .runRaw([["COMMAND", "GETKEYS", ...argv.map(str)]])
      .then((f) => {
        if (isError(f)) return c.replies.resolve(s, f);

        const keys = elements(f).map(bulkBytes),
          shard = shardOfKeys(keys, target.db.shards);

        if (shard < 0) return c.replies.resolve(s, CROSSSLOT);
        forward(c, shard, copy, retryable(c, entry), s, entry.flags.has("blocking"));
      }, c.replies.lost(s)),
  );
}
