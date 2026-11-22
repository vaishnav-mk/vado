// Key positions per command, from Valkey's own COMMAND output, plus the movable-key rules.
import { lower, str } from "./resp";
import type { CommandEntry, CommandTable, Reply } from "./types";

const list = (r: Reply | undefined): Reply[] => (Array.isArray(r) ? r : []);
const text = (r: Reply | undefined): string => (r instanceof Object ? "" : String(r));

function add(into: CommandTable, e: Reply): void {
  const [name, arity, flags, first, last, step, , , , subs] = list(e);

  const entry: CommandEntry = {
    name: text(name),
    arity: Number(arity),
    flags: new Set(list(flags).map(text)),
    first: Number(first),
    last: Number(last),
    step: Number(step),
    sub: null,
  };

  const children = list(subs);

  if (children.length) {
    entry.sub = new Map();

    for (const s of children) add(entry.sub, s);
  }

  into.set(entry.name.includes("|") ? entry.name.split("|")[1] : entry.name, entry);
}

/** The command table from a decoded COMMAND reply (RESP2). */
export function commandTable(reply: Reply): CommandTable {
  const table: CommandTable = new Map();

  for (const e of list(reply)) add(table, e);

  return table;
}

type Keys = (argv: Uint8Array[]) => number[] | null;

function numkeysAt(argv: Uint8Array[], at: number, firstKey: number): number[] | null {
  const n = Number(str(argv[at]));

  if (!Number.isInteger(n) || n < 0 || firstKey + n > argv.length) return null;

  return Array.from({ length: n }, (_, i) => firstKey + i);
}

const numkeys =
  (at: number, firstKey: number): Keys =>
  (argv) =>
    numkeysAt(argv, at, firstKey);

// The destination key first, then numkeys keys.
const storeThenNumkeys: Keys = (argv) => {
  const keys = numkeysAt(argv, 2, 3);

  return keys && [1, ...keys];
};

const streamsKeys: Keys = (argv) => {
  for (let i = 1; i < argv.length; i++) {
    if (lower(argv[i]) === "streams") {
      const n = (argv.length - i - 1) / 2;

      if (!Number.isInteger(n) || n < 1) return null;

      return Array.from({ length: n }, (_, k) => i + 1 + k);
    }
  }

  return null;
};

// BY/GET patterns may touch other keys; like Redis Cluster, they aren't routed.
const sortKeys: Keys = (argv) => {
  const keys = [1];

  for (let i = 2; i < argv.length - 1; i++) if (lower(argv[i]) === "store") keys.push(i + 1);

  return keys;
};

const geoKeys: Keys = (argv) => {
  const keys = [1];

  for (let i = 2; i < argv.length - 1; i++) {
    const w = lower(argv[i]);

    if (w === "store" || w === "storedist") keys.push(i + 1);
  }

  return keys;
};

// Commands whose keys aren't at fixed positions ("movablekeys").
const MOVABLE = new Map<string, Keys>([
  ["eval", numkeys(2, 3)],
  ["evalsha", numkeys(2, 3)],
  ["eval_ro", numkeys(2, 3)],
  ["evalsha_ro", numkeys(2, 3)],
  ["fcall", numkeys(2, 3)],
  ["fcall_ro", numkeys(2, 3)],
  ["zunion", numkeys(1, 2)],
  ["zinter", numkeys(1, 2)],
  ["zdiff", numkeys(1, 2)],
  ["zintercard", numkeys(1, 2)],
  ["sintercard", numkeys(1, 2)],
  ["lmpop", numkeys(1, 2)],
  ["zmpop", numkeys(1, 2)],
  ["blmpop", numkeys(2, 3)],
  ["bzmpop", numkeys(2, 3)],
  ["zunionstore", storeThenNumkeys],
  ["zinterstore", storeThenNumkeys],
  ["zdiffstore", storeThenNumkeys],
  ["xread", streamsKeys],
  ["xreadgroup", streamsKeys],
  ["sort", sortKeys],
  ["sort_ro", () => [1]],
  ["georadius", geoKeys],
  ["georadiusbymember", geoKeys],
  ["migrate", () => null],
]);

/** The argv indexes holding keys, [] for keyless commands, or null when unknown (the caller then asks Valkey with
 *  COMMAND GETKEYS). `name` is lowercase. */
export function keyIndexes(table: CommandTable, name: string, argv: Uint8Array[]): number[] | null {
  let e = table.get(name);

  if (!e) return null;

  if (e.sub && argv.length > 1) e = e.sub.get(lower(argv[1])) ?? e;

  if (e.flags.has("movablekeys")) {
    const keys = MOVABLE.get(name);

    return keys ? keys(argv) : null;
  }

  if (e.first <= 0) return [];
  const last = e.last < 0 ? argv.length + e.last : e.last;
  const out = [];

  for (let i = e.first; i <= last && i < argv.length; i += e.step || 1) out.push(i);

  return out;
}
