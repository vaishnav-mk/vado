import { decode } from "../protocol/decode";
import { arrayOf, command, elements, integer } from "../protocol/resp";
import type { Conn } from "./conn";
import { groupByShard } from "./key-shards";
import { OK, wrongArity } from "./replies-text";

type Merge = (frames: Uint8Array[], groups: number[][]) => Uint8Array;

export const sumOf = (frames: Uint8Array[]): Uint8Array => {
  let n = 0;

  for (const f of frames) n += Number(decode(f)[0]);

  return integer(n);
};

function scatter(
  c: Conn,
  groups: Map<number, number[]>,
  writes: boolean,
  request: (idx: number[]) => Uint8Array,
  merge: Merge,
): void {
  const s = c.replies.slot(),
    idxs = [...groups.values()],
    frames = Array.from<Uint8Array>({ length: idxs.length });

  let left = groups.size,
    failed: Uint8Array | null = null,
    k = 0;

  for (const [shard, idx] of groups) {
    const at = k++;

    if (writes) c.writes.start(shard);
    c.pool.get(shard).send(request(idx), (f) => {
      if (writes) c.writes.done(shard);

      if (f[0] === 45) failed ??= f;
      else frames[at] = f;

      if (--left === 0) c.replies.resolve(s, failed ?? merge(frames, idxs));
    });
  }
}

export function split(c: Conn, name: string, argv: Uint8Array[]): boolean {
  const args = argv.slice(1);

  switch (name) {
    case "mget":
      scatter(
        c,
        groupByShard(args, c.db.shards),
        false,
        (idx) => command(["MGET", ...idx.map((i) => args[i])]),
        (frames, idxs) => {
          const out = Array.from<Uint8Array>({ length: args.length });

          for (let k = 0; k < frames.length; k++) {
            const values = elements(frames[k]);

            for (let j = 0; j < idxs[k].length; j++) out[idxs[k][j]] = values[j];
          }

          return arrayOf(out);
        },
      );

      return true;
    case "mset":
      if (args.length % 2) c.replies.reply(wrongArity("mset"));
      else
        scatter(
          c,
          groupByShard(args, c.db.shards, 2),
          true,
          (idx) => command(["MSET", ...idx.flatMap((i) => [args[i], args[i + 1]])]),
          () => OK,
        );

      return true;
    case "del":
    case "unlink":
    case "exists":
    case "touch":
      scatter(
        c,
        groupByShard(args, c.db.shards),
        name !== "exists",
        (idx) => command([name.toUpperCase(), ...idx.map((i) => args[i])]),
        sumOf,
      );

      return true;
  }

  return false;
}
