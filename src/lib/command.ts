// "Run a command": the common commands' arguments, typed fields to argv, and replies shown as valkey-cli does.
import { ms, plural } from "./format";
import type { ReplicaState, TypedReply } from "./types";

export interface Arg {
  name: string;
  placeholder: string;
  /** Several values in one field, separated by spaces ("quote" a value that has spaces). */
  many?: boolean;
}

export const OTHER = "Other" as const; // as const, or the command Select's value type widens to string

/** Command -> its arguments, in order. Other is a whole command line. */
export const COMMANDS = {
  GET: [{ name: "Key", placeholder: "greeting" }],
  SET: [
    { name: "Key", placeholder: "greeting" },
    { name: "Value", placeholder: "hello world" },
  ],
  DEL: [{ name: "Keys", placeholder: "greeting counter", many: true }],
  INCR: [{ name: "Key", placeholder: "counter" }],
  EXPIRE: [
    { name: "Key", placeholder: "greeting" },
    { name: "Seconds", placeholder: "60" },
  ],
  TTL: [{ name: "Key", placeholder: "greeting" }],
  HSET: [
    { name: "Key", placeholder: "user:1" },
    { name: "Field", placeholder: "name" },
    { name: "Value", placeholder: "Ada" },
  ],
  HGET: [
    { name: "Key", placeholder: "user:1" },
    { name: "Field", placeholder: "name" },
  ],
  HGETALL: [{ name: "Key", placeholder: "user:1" }],
  LPUSH: [
    { name: "Key", placeholder: "queue" },
    { name: "Values", placeholder: "first second", many: true },
  ],
  LRANGE: [
    { name: "Key", placeholder: "queue" },
    { name: "Start", placeholder: "0" },
    { name: "Stop", placeholder: "-1" },
  ],
  SADD: [
    { name: "Key", placeholder: "tags" },
    { name: "Members", placeholder: "red green", many: true },
  ],
  SMEMBERS: [{ name: "Key", placeholder: "tags" }],
  ZADD: [
    { name: "Key", placeholder: "scores" },
    { name: "Score and member", placeholder: "10 ada 20 grace", many: true },
  ],
  ZRANGE: [
    { name: "Key", placeholder: "scores" },
    { name: "Start", placeholder: "0" },
    { name: "Stop", placeholder: "-1" },
  ],
  DBSIZE: [],
  [OTHER]: [{ name: "Command", placeholder: 'SET "my key" "hello world" EX 60', many: true }],
} satisfies Record<string, Arg[]>;

const ESCAPES = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["r", "\r"],
]);

/** Splits a line into arguments like valkey-cli: spaces separate, "double" quotes allow \" \\ \n \t \r \xHH, 'single' quotes are literal but for \'. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = line.length;

  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;

    if (i >= n) break;
    let arg = "";

    while (i < n && !/\s/.test(line[i])) {
      const q = line[i];

      if (q !== '"' && q !== "'") {
        arg += q;
        i++;
        continue;
      }

      i++;
      let closed = false;

      while (i < n) {
        const c = line[i];

        if (c === q) {
          closed = true;
          i++;
          break;
        }

        if (c === "\\" && i + 1 < n) {
          const e = line[i + 1];

          if (q === "'") {
            arg += e === "'" ? "'" : `\\${e}`;
            i += 2;
            continue;
          }

          if (e === "x" && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
            arg += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16));
            i += 4;
            continue;
          }

          arg += ESCAPES.get(e) ?? e;
          i += 2;
          continue;
        }

        arg += c;
        i++;
      }

      if (!closed) throw new Error(`A ${q === '"' ? "double" : "single"} quote isn't closed`);

      if (i < n && !/\s/.test(line[i])) throw new Error("Put a space after a closing quote");
    }

    out.push(arg);
  }

  return out;
}

/** The argv for `command` with `values` typed in its fields. Fields that take one value are taken as typed. */
export function toArgv(command: keyof typeof COMMANDS, values: string[]): string[] {
  if (command === OTHER) return splitArgs(values[0] ?? "");
  const args: Arg[] = COMMANDS[command];
  const argv: string[] = [command];
  args.forEach((a, k) => {
    const v = values[k] ?? "";

    if (a.many) argv.push(...splitArgs(v));
    else if (v !== "") argv.push(v);
  });

  return argv;
}

/** How valkey-cli would show argv: arguments with spaces or quotes in double quotes. */
export const showArgv = (argv: string[]) =>
  argv.map((a) => (a === "" || /[\s"'\\]/.test(a) ? JSON.stringify(a) : a)).join(" ");

/** A reply as valkey-cli prints it. */
export function showReply(r: TypedReply, depth = 0): string {
  switch (r.type) {
    case "status":
      return r.value;
    case "error":
      return `(error) ${r.value}`;
    case "integer":
      return `(integer) ${r.value}`;
    case "nil":
      return "(nil)";
    case "bulk":
      return JSON.stringify(r.value.length > 4000 ? `${r.value.slice(0, 4000)}…` : r.value);
    case "array": {
      if (!r.value.length) return "(empty array)";
      const width = String(r.value.length).length;

      return r.value
        .map((x, k) => `${k ? "   ".repeat(depth) : ""}${String(k + 1).padStart(width)}) ${showReply(x, depth + 1)}`)
        .join("\n");
    }
  }
}

/** Only "Copied to N of M" when the replicas were ready to take it; otherwise what they were doing. */
export function replicationLine(rep: { acked: number; of: number; ms: number }, before: ReplicaState[] | null) {
  const n = rep.of,
    took = ms(rep.ms);

  if (!before?.length)
    return rep.acked >= n
      ? `Copied to ${plural(n, "replica")} in ${took}.`
      : `Copied to ${rep.acked} of ${plural(n, "replica")} in ${took}. The others catch up on their own.`;

  const ready = before.filter((s) => s === "ready").length,
    asleep = before.filter((s) => s === "asleep").length;

  if (ready === before.length)
    return rep.acked >= n
      ? `Copied to all ${plural(n, "replica")} in ${took}.`
      : `Copied to ${rep.acked} of ${plural(n, "replica")} in ${took}. The others catch up on their own.`;
  const its = n === 1 ? "Its replica was" : `Its ${n} replicas were`;

  if (asleep === before.length)
    return `${its} asleep; this write wakes ${n === 1 ? "it" : "them"}, and ${n === 1 ? "it catches" : "they catch"} up in a few seconds.`;

  if (!ready) return `${its} still copying the shard, so ${n === 1 ? "it catches" : "they catch"} up in a few seconds.`;

  return `Copied to ${Math.min(rep.acked, ready)} of the ${ready} ready replicas in ${took}. The other ${n - ready} weren't ready and catch up in a few seconds.`;
}
