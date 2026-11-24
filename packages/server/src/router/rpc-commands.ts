import { arrayOf, bulk, elements, EMPTY, error, integer, isError, str } from "../protocol/resp";
import { sameBytes } from "../protocol/bytes";
import type { Conn } from "./conn";
import { bulkText, NOT_INTEGER, NULL_BULK, wrongArity } from "./replies-text";

// The cursor is the shard's cursor * shards + the shard index, so it stays one integer.
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

    if (isError(f)) return f;

    const [next, keys] = elements(f),
      innerNext = BigInt(bulkText(next)),
      after = BigInt(shard + 1);

    const composite = innerNext !== 0n ? innerNext * shards + BigInt(shard) : after < shards ? after : 0n;

    return arrayOf([bulk(composite.toString()), keys]);
  });
}

export function randomkey(c: Conn): void {
  const target = c.target,
    n = target.db.shards,
    start = Math.floor(Math.random() * n);

  c.replies.viaRpc(async () => {
    for (let k = 0; k < n; k++) {
      const f = await target.shard((start + k) % n).runRaw([["RANDOMKEY"]]);

      if (!sameBytes(f, NULL_BULK)) return f;
    }

    return NULL_BULK;
  });
}

export function wait(c: Conn, argv: Uint8Array[]): void {
  if (argv.length !== 3) return c.replies.reply(wrongArity("wait"));

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
