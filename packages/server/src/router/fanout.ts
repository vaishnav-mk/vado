import { decode } from "../protocol/decode";
import { arrayOf, bulk, elements, EMPTY, integer, isError, lower, str } from "../protocol/resp";
import type { CommandEntry } from "../protocol/types";
import { FUNCTION_EVERYWHERE, SCRIPT_EVERYWHERE } from "./command-sets";
import { CONFIG_SET } from "../protocol/commands";
import { FAN_OUT } from "./config";
import type { Conn } from "./conn";
import { OK, unsupported } from "./replies-text";
import { bulkText } from "../protocol/resp";
import { forward } from "./routing";
import { infoFields, subField } from "../protocol/info";

type Merge = (frames: Uint8Array[]) => Uint8Array;

async function everyShard(c: Conn, cmds: string[][]): Promise<Uint8Array[]> {
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

export function fanout(c: Conn, entry: CommandEntry | undefined, argv: Uint8Array[], merge: Merge): void {
  c.replies.viaRpc(async () => {
    const frames = await everyShard(c, [argv.map(str)]);

    if (!entry?.flags.has("readonly")) c.writes.all(c.db.shards);

    return frames.find((f) => isError(f)) ?? merge(frames);
  });
}

// SCRIPT EXISTS is true only where every shard has the script.
const everywhere: Merge = (frames) => {
  const lists = frames.map((f) => elements(f));

  return arrayOf(lists[0].map((_, i) => integer(lists.every((l) => l.length > i && decode(l[i])[0] === 1) ? 1 : 0)));
};

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
  fanout(c, entry, argv, (frames) => frames[0]);
}

export function config(c: Conn, entry: CommandEntry | undefined, argv: Uint8Array[], raw: Uint8Array): void {
  const sub = lower(argv[1] ?? EMPTY);

  if (sub === "set")
    for (let i = 2; i < argv.length; i += 2) {
      const setting = lower(argv[i]);

      if (!CONFIG_SET.has(setting)) return c.replies.reply(unsupported(`config set ${setting}`));
    }

  if (sub === "set" || sub === "resetstat") return fanout(c, entry, argv, () => OK);
  forward(c, 0, raw);
}

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
      const db0 = infoFields(bulkText(f)).db0;
      keys += subField(db0, "keys");
      expires += subField(db0, "expires");
    }

    const body =
      bulkText(head).replace(/# Keyspace\r\n(db\d+:[^\r]*\r\n)*/, "") +
      `# Keyspace\r\n${keys ? `db0:keys=${keys},expires=${expires},avg_ttl=0\r\n` : ""}` +
      `\r\n# Router\r\nrouter_db:${target.db.name}\r\nrouter_shards:${target.db.shards}\r\n`;

    return bulk(body);
  });
}
