// Commands that go to every shard by RPC (no upstream connections held), in order with the socket path (viaRpc).
import { decode } from "../protocol/decode";
import { arrayOf, bulk, elements, integer, lower, str } from "../protocol/resp";
import type { CommandEntry } from "../protocol/types";
import { CONFIG_SET, FUNCTION_EVERYWHERE, SCRIPT_EVERYWHERE } from "./command-sets";
import { FAN_OUT } from "./config";
import type { Conn } from "./conn";
import { bulkText, EMPTY, OK, unsupported } from "./replies-text";
import { forward } from "./routing";

type Merge = (frames: Uint8Array[]) => Uint8Array;

/** Runs `cmds` on every shard, at most FAN_OUT at a time; raw replies in shard order. */
export async function everyShard(c: Conn, cmds: string[][]): Promise<Uint8Array[]> {
  const target = c.target,
    n = target.db.shards,
    out = Array.from<Uint8Array>({ length: n });

  let next = 0;

  const worker = async () => {
    for (let i = next++; i < n; i = next++) out[i] = await target.shard(i).runRaw(cmds);
  };

  await Promise.all(Array.from({ length: Math.min(FAN_OUT, n) }, worker));

  return out;
}

/** The first shard's error, or the merged replies. A fan-out that may write counts as a write to every shard. */
function fanout(c: Conn, entry: CommandEntry | undefined, argv: Uint8Array[], merge: Merge): void {
  c.replies.viaRpc(async () => {
    const frames = await everyShard(c, [argv.map(str)]);

    if (!entry?.flags.has("readonly")) c.writes.all(c.db.shards);

    return frames.find((f) => f[0] === 45) ?? merge(frames);
  });
}

const ok: Merge = () => OK;
const first: Merge = (frames) => frames[0];

const total: Merge = (frames) => {
  let n = 0;

  for (const f of frames) n += Number(decode(f)[0]);

  return integer(n);
};

const allKeys: Merge = (frames) => arrayOf(frames.flatMap((f) => elements(f)));

// SCRIPT EXISTS: true only where every shard has the script.
const everywhere: Merge = (frames) => {
  const lists = frames.map((f) => elements(f));

  return arrayOf(lists[0].map((_, i) => integer(lists.every((l) => l.length > i && decode(l[i])[0] === 1) ? 1 : 0)));
};

export const dbsize = (c: Conn, entry: CommandEntry | undefined, argv: Uint8Array[]) => fanout(c, entry, argv, total);

export const keys = (c: Conn, entry: CommandEntry | undefined, argv: Uint8Array[]) => fanout(c, entry, argv, allKeys);

export const flush = (c: Conn, entry: CommandEntry | undefined, argv: Uint8Array[]) => fanout(c, entry, argv, ok);

/** SCRIPT LOAD/FLUSH and FUNCTION LOAD/DELETE/FLUSH/RESTORE go to every shard; the rest to shard 0. */
export function scriptOrFunction(
  c: Conn,
  name: string,
  entry: CommandEntry | undefined,
  argv: Uint8Array[],
  raw: Uint8Array,
): void {
  const sub = lower(argv[1] ?? EMPTY),
    script = name === "script";

  if (script && sub === "exists") return fanout(c, entry, argv, everywhere);

  if (!(script ? SCRIPT_EVERYWHERE : FUNCTION_EVERYWHERE).has(sub)) return forward(c, 0, raw);
  fanout(c, entry, argv, first);
}

/** CONFIG SET (only CONFIG_SET's settings) and RESETSTAT go to every shard; the rest to shard 0. */
export function config(c: Conn, entry: CommandEntry | undefined, argv: Uint8Array[], raw: Uint8Array): void {
  const sub = lower(argv[1] ?? EMPTY);

  if (sub === "set")
    for (let i = 2; i < argv.length; i += 2) {
      const setting = lower(argv[i]);

      if (!CONFIG_SET.has(setting)) return c.replies.reply(unsupported(`config set ${setting}`));
    }

  if (sub === "set" || sub === "resetstat") return fanout(c, entry, argv, ok);
  forward(c, 0, raw);
}

/** INFO from shard 0, with the keyspace summed over every shard and a Router section. */
export function info(c: Conn, argv: Uint8Array[]): void {
  const section = argv.slice(1).map(str),
    target = c.target;

  c.replies.viaRpc(async () => {
    const [head, spaces] = await Promise.all([
      target.shard(0).runRaw([["INFO", ...section]]),
      everyShard(c, [["INFO", "keyspace"]]),
    ]);

    let keys = 0,
      expires = 0;

    for (const f of spaces) {
      const m = /db0:keys=(\d+),expires=(\d+)/.exec(bulkText(f));

      if (m) {
        keys += Number(m[1]);
        expires += Number(m[2]);
      }
    }

    const body =
      bulkText(head).replace(/# Keyspace\r\n(db\d+:[^\r]*\r\n)*/, "") +
      `# Keyspace\r\n${keys ? `db0:keys=${keys},expires=${expires},avg_ttl=0\r\n` : ""}` +
      `\r\n# Router\r\nrouter_db:${target.db.name}\r\nrouter_shards:${target.db.shards}\r\n`;

    return bulk(body);
  });
}
