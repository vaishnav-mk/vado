// Multi-key commands whose keys span shards: one request per shard, replies merged into one.
import { decode } from "../protocol/decode";
import { arrayOf, command, elements, integer } from "../protocol/resp";
import type { Conn } from "./conn";
import { groupByShard } from "./key-shards";
import { OK, wrongArity } from "./replies-text";

type Gather = (frame: Uint8Array, idx: number[]) => void;

/** Sends `request(idx)` to each shard's group; the first error, or `result()` once every shard has answered. */
function scatter(
  c: Conn,
  groups: Map<number, number[]>,
  writes: boolean,
  request: (idx: number[]) => Uint8Array,
  gather: Gather | null,
  result: () => Uint8Array,
): void {
  const s = c.replies.slot();

  let left = groups.size,
    failed: Uint8Array | null = null;

  for (const [shard, idx] of groups) {
    if (writes) c.writes.start(shard);
    c.pool.get(shard).send(request(idx), (f) => {
      if (writes) c.writes.done(shard);

      if (f[0] === 45) failed ??= f;
      else gather?.(f, idx);

      if (--left === 0) c.replies.resolve(s, failed ?? result());
    });
  }
}

function mget(c: Conn, keys: Uint8Array[]): void {
  const out = Array.from<Uint8Array>({ length: keys.length });

  scatter(
    c,
    groupByShard(keys, c.db.shards),
    false,
    (idx) => command(["MGET", ...idx.map((i) => keys[i])]),
    (f, idx) => {
      const values = elements(f);

      for (let k = 0; k < idx.length; k++) out[idx[k]] = values[k];
    },
    () => arrayOf(out),
  );
}

function mset(c: Conn, args: Uint8Array[]): void {
  if (args.length % 2) return c.replies.reply(wrongArity("mset"));
  scatter(
    c,
    groupByShard(args, c.db.shards, 2),
    true,
    (idx) => command(["MSET", ...idx.flatMap((i) => [args[i], args[i + 1]])]),
    null,
    () => OK,
  );
}

// DEL, UNLINK, EXISTS, TOUCH: the counts add up.
function sum(c: Conn, name: string, keys: Uint8Array[]): void {
  const upper = name.toUpperCase();
  let total = 0;

  scatter(
    c,
    groupByShard(keys, c.db.shards),
    name !== "exists",
    (idx) => command([upper, ...idx.map((i) => keys[i])]),
    (f) => {
      total += Number(decode(f)[0]);
    },
    () => integer(total),
  );
}

/** Splits a cross-slot command by shard if it is one that can be; false if not. */
export function split(c: Conn, name: string, argv: Uint8Array[]): boolean {
  switch (name) {
    case "mget":
      mget(c, argv.slice(1));

      return true;
    case "mset":
      mset(c, argv.slice(1));

      return true;
    case "del":
    case "unlink":
    case "exists":
    case "touch":
      sum(c, name, argv.slice(1));

      return true;
  }

  return false;
}
