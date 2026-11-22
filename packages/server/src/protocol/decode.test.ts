import { expect, test } from "vite-plus/test";
import { decode, decodeAll } from "./decode";
import { bulk, elements, error, lower } from "./resp";

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

test("encoders and helpers", () => {
  expect(new TextDecoder().decode(error("ERR a\r\nb"))).toBe("-ERR a  b\r\n");
  expect(new TextDecoder().decode(bulk(null))).toBe("$-1\r\n");
  expect(new TextDecoder().decode(bulk(42))).toBe("$2\r\n42\r\n");
  expect(elements(enc.encode("*2\r\n:1\r\n$1\r\nx\r\n")).map((e) => new TextDecoder().decode(e))).toEqual([
    ":1\r\n",
    "$1\r\nx\r\n",
  ]);
  expect(lower(enc.encode("GeT"))).toBe("get");
  expect(lower(enc.encode("X".repeat(70)))).toBe("x".repeat(70));
});
