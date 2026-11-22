// Key positions per command, from Valkey's own COMMAND output, plus the movable-key rules.
import { lower, str } from "./resp.js";

/** Builds { name -> { first, last, step, flags, sub } } from a decoded COMMAND reply (RESP2). */
export function commandTable(reply) {
  const table = new Map();
  const add = (into, e) => {
    const [name, arity, flags, first, last, step, , , , subs] = e;
    const entry = { name, arity, flags: new Set(flags), first, last, step, sub: null };
    if (Array.isArray(subs) && subs.length) {
      entry.sub = new Map();
      for (const s of subs) add(entry.sub, s);
    }
    into.set(name.includes("|") ? name.split("|")[1] : name, entry);
  };
  for (const e of reply) add(table, e);
  return table;
}

const numkeysAt = (argv, at, firstKey) => {
  const n = Number(str(argv[at]));
  if (!Number.isInteger(n) || n < 0 || firstKey + n > argv.length) return null;
  return Array.from({ length: n }, (_, i) => firstKey + i);
};

// Commands whose keys are not at fixed positions ("movablekeys"). Each returns argv indexes or null.
const MOVABLE = {
  eval: (a) => numkeysAt(a, 2, 3), evalsha: (a) => numkeysAt(a, 2, 3),
  eval_ro: (a) => numkeysAt(a, 2, 3), evalsha_ro: (a) => numkeysAt(a, 2, 3),
  fcall: (a) => numkeysAt(a, 2, 3), fcall_ro: (a) => numkeysAt(a, 2, 3),
  zunion: (a) => numkeysAt(a, 1, 2), zinter: (a) => numkeysAt(a, 1, 2), zdiff: (a) => numkeysAt(a, 1, 2),
  zintercard: (a) => numkeysAt(a, 1, 2), sintercard: (a) => numkeysAt(a, 1, 2),
  lmpop: (a) => numkeysAt(a, 1, 2), zmpop: (a) => numkeysAt(a, 1, 2),
  blmpop: (a) => numkeysAt(a, 2, 3), bzmpop: (a) => numkeysAt(a, 2, 3),
  zunionstore: (a) => { const k = numkeysAt(a, 2, 3); return k && [1, ...k]; },
  zinterstore: (a) => { const k = numkeysAt(a, 2, 3); return k && [1, ...k]; },
  zdiffstore: (a) => { const k = numkeysAt(a, 2, 3); return k && [1, ...k]; },
  xread: (a) => streamsKeys(a), xreadgroup: (a) => streamsKeys(a),
  sort: (a) => sortKeys(a), sort_ro: () => [1],
  georadius: (a) => storeKeys(a, 1), georadiusbymember: (a) => storeKeys(a, 1),
  migrate: () => null,
};

function streamsKeys(argv) {
  for (let i = 1; i < argv.length; i++) {
    if (lower(argv[i]) === "streams") {
      const n = (argv.length - i - 1) / 2;
      if (!Number.isInteger(n) || n < 1) return null;
      return Array.from({ length: n }, (_, k) => i + 1 + k);
    }
  }
  return null;
}

function sortKeys(argv) {
  const keys = [1];
  for (let i = 2; i < argv.length - 1; i++) if (lower(argv[i]) === "store") keys.push(i + 1);
  return keys; // BY/GET patterns may touch other keys; like Redis Cluster we don't route them
}

function storeKeys(argv, first) {
  const keys = [first];
  for (let i = first + 1; i < argv.length - 1; i++) {
    const w = lower(argv[i]);
    if (w === "store" || w === "storedist") keys.push(i + 1);
  }
  return keys;
}

/**
 * The argv indexes holding keys, [] for keyless commands, or null when unknown (the caller then
 * asks Valkey with COMMAND GETKEYS). `name` is lowercase.
 */
export function keyIndexes(table, name, argv) {
  let e = table.get(name);
  if (!e) return null;
  if (e.sub && argv.length > 1) {
    const s = e.sub.get(lower(argv[1]));
    if (s) e = s;
  }
  if (e.flags.has("movablekeys")) {
    const f = MOVABLE[name];
    return f ? f(argv) : null;
  }
  if (e.first <= 0) return [];
  const last = e.last < 0 ? argv.length + e.last : e.last;
  const out = [];
  for (let i = e.first; i <= last && i < argv.length; i += e.step || 1) out.push(i);
  return out;
}
