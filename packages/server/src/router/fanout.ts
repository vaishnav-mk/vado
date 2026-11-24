import { sameBytes } from "../protocol/bytes";
import { CONFIG_SET } from "../protocol/commands";
import { decode } from "../protocol/decode";
import { infoFields, subField } from "../protocol/info";
import { arrayOf, bulk, bulkText, elements, EMPTY, error, integer, isError, lower, str } from "../protocol/resp";
import type { CommandEntry } from "../protocol/types";
import { FUNCTION_EVERYWHERE, SCRIPT_EVERYWHERE } from "./command-sets";
import { FAN_OUT } from "./config";
import type { Conn } from "./conn";
import { NOT_INTEGER, NULL_BULK, OK, unsupported, wrongArity, ZERO } from "./replies-text";
import { forward } from "./routing";
import type { Merge } from "./types";

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

    return frames.find(isError) ?? merge(frames);
  });
}

// SCRIPT EXISTS is true only where every shard has the script.
const everywhere: Merge = (frames) => {
  const lists = frames.map(elements);

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

  if (!replicas) return c.replies.reply(ZERO);
  const wrote = c.writes.shards();

  c.replies.viaRpc(async () => {
    const counts = wrote.length
      ? await Promise.all(wrote.map((i) => target.shard(i).waitReplicas(n, ms)))
      : [replicas.length];

    return integer(Math.min(...counts));
  });
}
