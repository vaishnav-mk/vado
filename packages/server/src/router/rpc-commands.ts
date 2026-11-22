// Commands answered by RPC to chosen shards: SCAN, RANDOMKEY, WAIT.
import { arrayOf, bulk, elements, error, integer, str } from "../protocol/resp";
import type { Conn } from "./conn";
import { bulkText, EMPTY, NOT_INTEGER, NULL_BULK } from "./replies-text";

/** SCAN's cursor is the shard's cursor * shards + the shard index, so it stays one integer. */
export function scan(c: Conn, argv: Uint8Array[]): void {
  const shards = BigInt(c.db.shards),
    target = c.target;

  let cursor: bigint;

  try {
    cursor = BigInt(str(argv[1] ?? EMPTY));
  } catch {
    cursor = -1n;
  }

  if (cursor < 0n) return c.replies.reply(error("ERR invalid cursor"));

  const shard = Number(cursor % shards),
    inner = cursor / shards;

  c.replies.viaRpc(async () => {
    const f = await target.shard(shard).runRaw([["SCAN", inner.toString(), ...argv.slice(2).map(str)]]);

    if (f[0] === 45) return f;

    const [next, keys] = elements(f),
      innerNext = BigInt(bulkText(next)),
      after = BigInt(shard + 1);

    const composite = innerNext !== 0n ? innerNext * shards + BigInt(shard) : after < shards ? after : 0n;

    return arrayOf([bulk(composite.toString()), keys]);
  });
}

// A RESP2 null bulk string: "$-1\r\n".
const isNull = (f: Uint8Array) => f[0] === 36 && f[1] === 45;

/** A random key of a random shard, trying the others in turn while they are empty. */
export function randomkey(c: Conn): void {
  const target = c.target,
    n = target.db.shards,
    start = Math.floor(Math.random() * n);

  c.replies.viaRpc(async () => {
    for (let k = 0; k < n; k++) {
      const f = await target.shard((start + k) % n).runRaw([["RANDOMKEY"]]);

      if (!isNull(f)) return f;
    }

    return NULL_BULK;
  });
}

/**
 * WAIT numreplicas timeout: how many replicas have every write this connection made, the fewest over the shards it
 * wrote to. Each shard counts its own replicas once the earlier replies (the writes) are back.
 */
export function wait(c: Conn, argv: Uint8Array[]): void {
  if (argv.length !== 3) return c.replies.reply(NOT_INTEGER);

  const n = Number(str(argv[1])),
    ms = Number(str(argv[2]));

  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(ms) || ms < 0) return c.replies.reply(NOT_INTEGER);

  const replicas = c.db.replicas,
    target = c.target;

  if (!replicas) return c.replies.reply(integer(0));
  const wrote = c.writes.shards();

  c.replies.viaRpc(async () => {
    const counts = wrote.length
      ? await Promise.all(wrote.map((i) => target.shard(i).waitReplicas(n, ms)))
      : [replicas.length];

    return integer(Math.min(...counts));
  });
}
