import { expect, test } from "vite-plus/test";
import { bulk } from "../protocol/resp";
import type { CommandEntry } from "../protocol/types";
import { CONFIG_SET, NOT_IN_MULTI, UNSUPPORTED } from "./command-sets";
import { arityError, bulkBytes, bulkText, unknownCommand } from "./replies-text";

const enc = new TextEncoder();
const dec = new TextDecoder();
const argv = (...words: string[]) => words.map((w) => enc.encode(w));
const text = (b: Uint8Array | null) => (b === null ? null : dec.decode(b));

const entry = (arity: number): CommandEntry => ({
  name: "get",
  arity,
  flags: new Set(),
  first: 1,
  last: 1,
  step: 1,
  sub: null,
});

test("unknown commands get Valkey's wording, arguments cut at 128 characters", () => {
  expect(text(unknownCommand(argv("FOO", "a", "b")))).toBe(
    "-ERR unknown command 'FOO', with args beginning with: 'a' 'b' \r\n",
  );
  expect(text(unknownCommand(argv("nope")))).toBe("-ERR unknown command 'nope', with args beginning with: \r\n");

  const long = text(unknownCommand(argv("x", "y".repeat(200), "z")));
  expect(long).toBe(`-ERR unknown command 'x', with args beginning with: '${"y".repeat(128)}' \r\n`);
  expect(text(unknownCommand(argv("a\r\nb"))), "newlines can't end the frame").toBe(
    "-ERR unknown command 'a  b', with args beginning with: \r\n",
  );
});

test("arity: exact when positive, a minimum when negative", () => {
  expect(arityError(entry(2), "get", argv("GET", "k"))).toBe(null);
  expect(text(arityError(entry(2), "get", argv("GET")))).toBe("-ERR wrong number of arguments for 'get' command\r\n");
  expect(arityError(entry(-2), "del", argv("DEL", "a", "b"))).toBe(null);
  expect(text(arityError(entry(-2), "del", argv("DEL")))).toBe("-ERR wrong number of arguments for 'del' command\r\n");
  expect(text(arityError(undefined, "x", argv("x")))).toMatch(/^-ERR unknown command 'x'/);
});

test("bulk frames read back as their bytes", () => {
  expect(dec.decode(bulkBytes(bulk("hello")))).toBe("hello");
  expect(bulkText(bulk("a\r\nb"))).toBe("a\r\nb");
  expect(bulkText(bulk(null))).toBe("");
  expect(bulkText(enc.encode("-ERR x\r\n")), "not a bulk string").toBe("");
});

test("clients can't change the service's settings", () => {
  for (const setting of ["maxmemory", "appendonly", "appendfsync", "requirepass", "port", "bind", "dir", "save"])
    expect(CONFIG_SET.has(setting), setting).toBe(false);

  for (const name of ["save", "bgrewriteaof", "acl", "shutdown"]) expect(UNSUPPORTED.has(name), name).toBe(true);

  for (const name of ["auth", "hello", "select", "flushall", "scan", "info", "config", "wait"])
    expect(NOT_IN_MULTI.has(name), name).toBe(true);
});
