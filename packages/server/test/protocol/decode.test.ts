import { expect, test } from "vite-plus/test";
import { decode, decodeAll, decodeTyped } from "../../src/protocol/decode";

const enc = new TextEncoder();
const one = (s: string) => decode(enc.encode(s))[0];

test("decode reads every RESP3 type", () => {
  expect(one("+OK\r\n")).toBe("OK");
  expect(one("-ERR no\r\n")).toEqual({ err: "ERR no" });
  expect(one(":-12\r\n")).toBe(-12);
  expect(one("_\r\n")).toBe(null);
  expect(one("#t\r\n")).toBe(true);
  expect(one("#f\r\n")).toBe(false);
  expect(one(",1.5\r\n")).toBe(1.5);
  expect(one("(12345678901234567890\r\n")).toBe(12345678901234567890n);
  expect(one("$3\r\nabc\r\n")).toBe("abc");
  expect(one("$-1\r\n")).toBe(null);
  expect(one("!3\r\nERR\r\n")).toEqual({ err: "ERR" });
  expect(one("=7\r\ntxt:abc\r\n")).toBe("abc");
  expect(one("*2\r\n:1\r\n~1\r\n+a\r\n")).toEqual([1, ["a"]]);
  expect(one("*-1\r\n")).toBe(null);
  expect(one("%1\r\n+k\r\n:1\r\n")).toEqual(new Map([["k", 1]]));
  expect(one("|1\r\n+ttl\r\n:3\r\n$2\r\nhi\r\n"), "an attribute is dropped").toBe("hi");
  expect(() => one("+OK")).toThrow(/incomplete/);
  expect(() => one("?x\r\n")).toThrow(/unexpected byte/);
});

test("decodeAll reads frames back to back", () => {
  expect(decodeAll(enc.encode("+OK\r\n:2\r\n$1\r\nx\r\n"))).toEqual(["OK", 2, "x"]);
});

test("decodeTyped keeps each RESP2 reply's type", () => {
  const typed = (s: string) => decodeTyped(enc.encode(s))[0];
  expect(typed("+OK\r\n")).toEqual({ type: "status", value: "OK" });
  expect(typed("$2\r\nOK\r\n")).toEqual({ type: "bulk", value: "OK" });
  expect(typed("-ERR nope\r\n")).toEqual({ type: "error", value: "ERR nope" });
  expect(typed(":-3\r\n")).toEqual({ type: "integer", value: -3 });
  expect(typed("$-1\r\n")).toEqual({ type: "nil" });
  expect(typed("*-1\r\n")).toEqual({ type: "nil" });
  expect(typed("*3\r\n$0\r\n\r\n*2\r\n:1\r\n$-1\r\n+QUEUED\r\n")).toEqual({
    type: "array",
    value: [
      { type: "bulk", value: "" },
      { type: "array", value: [{ type: "integer", value: 1 }, { type: "nil" }] },
      { type: "status", value: "QUEUED" },
    ],
  });
  expect(decodeTyped(enc.encode("$2\r\nhi\r\n:1\r\n"))[1], "the next frame's offset").toBe(8);
  expect(() => typed("%1\r\n+k\r\n:1\r\n")).toThrow(/RESP2/);
});
