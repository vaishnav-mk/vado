// "Run a command": the common commands with their arguments, turning what was typed into argv, and showing
// a reply the way valkey-cli does. Pure functions, tested by lib.test.ts.
import { ms, plural } from "./format.ts";
import type { ReplicaState, Reply } from "./types";

export interface Arg {
  name: string;
  placeholder: string;
  /** Several values in one field, separated by spaces ("quote" a value that has spaces). */
  many?: boolean;
}

export const OTHER = "Other";

/** Command -> its arguments, in order. Other is a whole command line. */
export const COMMANDS: Record<string, Arg[]> = {
  GET: [{ name: "Key", placeholder: "greeting" }],
  SET: [{ name: "Key", placeholder: "greeting" }, { name: "Value", placeholder: "hello world" }],
  DEL: [{ name: "Keys", placeholder: "greeting counter", many: true }],
  INCR: [{ name: "Key", placeholder: "counter" }],
  EXPIRE: [{ name: "Key", placeholder: "greeting" }, { name: "Seconds", placeholder: "60" }],
  TTL: [{ name: "Key", placeholder: "greeting" }],
  HSET: [{ name: "Key", placeholder: "user:1" }, { name: "Field", placeholder: "name" }, { name: "Value", placeholder: "Ada" }],
  HGET: [{ name: "Key", placeholder: "user:1" }, { name: "Field", placeholder: "name" }],
  HGETALL: [{ name: "Key", placeholder: "user:1" }],
  LPUSH: [{ name: "Key", placeholder: "queue" }, { name: "Values", placeholder: "first second", many: true }],
  LRANGE: [{ name: "Key", placeholder: "queue" }, { name: "Start", placeholder: "0" }, { name: "Stop", placeholder: "-1" }],
  SADD: [{ name: "Key", placeholder: "tags" }, { name: "Members", placeholder: "red green", many: true }],
  SMEMBERS: [{ name: "Key", placeholder: "tags" }],
  ZADD: [{ name: "Key", placeholder: "scores" }, { name: "Score and member", placeholder: "10 ada 20 grace", many: true }],
  ZRANGE: [{ name: "Key", placeholder: "scores" }, { name: "Start", placeholder: "0" }, { name: "Stop", placeholder: "-1" }],
  DBSIZE: [],
  [OTHER]: [{ name: "Command", placeholder: 'SET "my key" "hello world" EX 60', many: true }],
};

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
      if (q !== '"' && q !== "'") { arg += q; i++; continue; }
      i++;
      let closed = false;
      while (i < n) {
        const c = line[i];
        if (c === q) { closed = true; i++; break; }
        if (c === "\\" && i + 1 < n) {
          const e = line[i + 1];
          if (q === "'") { arg += e === "'" ? "'" : `\\${e}`; i += 2; continue; }
          if (e === "x" && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) { arg += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16)); i += 4; continue; }
          arg += ({ n: "\n", t: "\t", r: "\r" } as Record<string, string>)[e] ?? e;
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
export function toArgv(command: string, values: string[]): string[] {
  if (command === OTHER) return splitArgs(values[0] ?? "");
  const args = COMMANDS[command] ?? [];
  const argv = [command];
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

const isError = (v: Reply): v is { err: string } => typeof v === "object" && v !== null && !Array.isArray(v) && "err" in v;
const STATUS = new Set(["OK", "PONG", "QUEUED"]);

/** A reply as valkey-cli prints it. */
export function showReply(v: Reply, depth = 0): string {
  if (v === null) return "(nil)";
  if (typeof v === "number") return Number.isInteger(v) ? `(integer) ${v}` : `(double) ${v}`;
  if (typeof v === "boolean") return v ? "(true)" : "(false)";
  if (isError(v)) return `(error) ${v.err}`;
  if (Array.isArray(v)) {
    if (!v.length) return "(empty array)";
    const width = String(v.length).length;
    return v.map((x, k) => `${k ? "   ".repeat(depth) : ""}${String(k + 1).padStart(width)}) ${showReply(x, depth + 1)}`).join("\n");
  }
  const s = String(v);
  return STATUS.has(s) ? s : JSON.stringify(s.length > 4000 ? `${s.slice(0, 4000)}…` : s);
}

/** Only "Copied to N of M" when the replicas were ready to take it; otherwise what they were doing. */
export function replicationLine(rep: { acked: number; of: number; ms: number }, before: ReplicaState[] | null) {
  const n = rep.of, took = ms(rep.ms);
  if (!before?.length) return rep.acked >= n ? `Copied to ${plural(n, "replica")} in ${took}.` : `Copied to ${rep.acked} of ${plural(n, "replica")} in ${took}. The others catch up on their own.`;
  const ready = before.filter((s) => s === "ready").length, asleep = before.filter((s) => s === "asleep").length;
  if (ready === before.length) return rep.acked >= n ? `Copied to all ${plural(n, "replica")} in ${took}.` : `Copied to ${rep.acked} of ${plural(n, "replica")} in ${took}. The others catch up on their own.`;
  const its = n === 1 ? "Its replica was" : `Its ${n} replicas were`;
  if (asleep === before.length) return `${its} asleep; this write wakes ${n === 1 ? "it" : "them"}, and ${n === 1 ? "it catches" : "they catch"} up in a few seconds.`;
  if (!ready) return `${its} still copying the shard, so ${n === 1 ? "it catches" : "they catch"} up in a few seconds.`;
  return `Copied to ${Math.min(rep.acked, ready)} of the ${ready} ready replicas in ${took}. The other ${n - ready} weren't ready and catch up in a few seconds.`;
}
