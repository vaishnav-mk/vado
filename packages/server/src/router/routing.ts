import { elements, str } from "../protocol/resp";
import type { CommandEntry } from "../protocol/types";
import type { Conn } from "./conn";
import { replicaFailed, replicaResting } from "./isolate";
import { shardAt, shardOfKeys } from "./key-shards";
import type { Slot } from "./replies";
import { bulkBytes, CROSSSLOT, LOST } from "./replies-text";
import { split } from "./split";
import type { UpKey } from "./types";

/** Read-only and non-blocking, outside MULTI/WATCH: may go to a replica, and again to the primary if it fails. */
export const retryable = (c: Conn, entry: CommandEntry) =>
  entry.flags.has("readonly") && !entry.flags.has("blocking") && !c.tx.pinned;

/**
 * Sends `raw` to `shard`. A retryable read may go to a nearby replica, and goes once more to the primary if its
 * upstream was lost under it; anything else gets LOST (it may have run), and counts as a write.
 */
export function forward(c: Conn, shard: number, raw: Uint8Array, retry = false, s: Slot = c.replies.slot()): void {
  const copy = retry ? raw.slice() : null;
  let from: UpKey = shard;

  if (retry) from = readFrom(c, shard);
  else c.writes.start(shard);
  c.pool.get(from).send(raw, (f) => {
    if (!retry) c.writes.done(shard);

    if (f === LOST && copy) {
      if (from !== shard) replicaFailed(c.db.name, shard);

      return c.pool.get(shard).send(copy, (g) => c.replies.resolve(s, g));
    }

    c.replies.resolve(s, f);
  });
}

// Where a read of `shard` goes: "r<shard>" (a nearby replica) or the primary.
function readFrom(c: Conn, shard: number): UpKey {
  if (!c.db.replicas || c.tx.pinned) return shard;
  const now = Date.now();

  if (c.writes.recent(shard, now) || replicaResting(c.db.name, shard, now)) return shard;
  const key: UpKey = `r${shard}`;

  return c.pool.has(key) || c.target.replica(shard) ? key : shard;
}

/** Routes a command whose keys are at argv[idx[0]], argv[idx[1]], ... */
export function routeKeys(
  c: Conn,
  name: string,
  entry: CommandEntry,
  argv: Uint8Array[],
  raw: Uint8Array,
  idx: number[],
): void {
  if (!idx.length || c.db.shards === 1) return forward(c, 0, raw, retryable(c, entry));
  const shard = shardAt(argv, idx, c.db.shards);

  if (shard >= 0) return forward(c, shard, raw, retryable(c, entry));

  if (!split(c, name, argv)) c.replies.reply(CROSSSLOT);
}

/** Key positions unknown: asks Valkey (COMMAND GETKEYS), then routes. The reply slot is taken first, for order. */
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
        if (f[0] === 45) return c.replies.resolve(s, f);

        const keys = elements(f).map(bulkBytes),
          shard = !keys.length || target.db.shards === 1 ? 0 : shardOfKeys(keys, target.db.shards);

        if (shard < 0) return c.replies.resolve(s, CROSSSLOT);
        forward(c, shard, copy, retryable(c, entry), s);
      }, c.replies.lost(s)),
  );
}
