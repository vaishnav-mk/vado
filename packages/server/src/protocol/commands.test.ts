import { expect, test } from "vite-plus/test";
import { commandTable, keyIndexes } from "./commands";

const enc = new TextEncoder();
const argv = (...words: string[]) => words.map((w) => enc.encode(w));

// As COMMAND (RESP2) decodes: name, arity, flags, first, last, step, acl, tips, key specs, subcommands.
const table = commandTable([
  ["get", 2, ["readonly"], 1, 1, 1, [], [], [], []],
  ["mset", -3, ["write"], 1, -1, 2, [], [], [], []],
  ["ping", -1, ["fast"], 0, 0, 0, [], [], [], []],
  ["eval", -3, ["movablekeys"], 0, 0, 0, [], [], [], []],
  ["zunionstore", -4, ["movablekeys"], 1, 1, 1, [], [], [], []],
  ["xread", -4, ["movablekeys"], 0, 0, 0, [], [], [], []],
  ["sort", -2, ["movablekeys"], 1, 1, 1, [], [], [], []],
  ["object", -2, [], 0, 0, 0, [], [], [], [["object|encoding", 3, ["readonly"], 2, 2, 1, [], [], [], []]]],
]);

test("keyIndexes finds keys at fixed and movable positions", () => {
  expect(keyIndexes(table, "get", argv("GET", "a"))).toEqual([1]);
  expect(keyIndexes(table, "mset", argv("MSET", "a", "1", "b", "2"))).toEqual([1, 3]);
  expect(keyIndexes(table, "ping", argv("PING"))).toEqual([]);
  expect(keyIndexes(table, "nope", argv("NOPE"))).toBe(null);
  expect(keyIndexes(table, "eval", argv("EVAL", "s", "2", "a", "b", "x"))).toEqual([3, 4]);
  expect(keyIndexes(table, "eval", argv("EVAL", "s", "9", "a")), "numkeys past the end").toBe(null);
  expect(keyIndexes(table, "zunionstore", argv("ZUNIONSTORE", "d", "2", "a", "b"))).toEqual([1, 3, 4]);
  expect(keyIndexes(table, "xread", argv("XREAD", "COUNT", "1", "STREAMS", "a", "b", "0", "0"))).toEqual([4, 5]);
  expect(keyIndexes(table, "sort", argv("SORT", "a", "STORE", "d"))).toEqual([1, 3]);
  expect(keyIndexes(table, "object", argv("OBJECT", "ENCODING", "k"))).toEqual([2]);
});
