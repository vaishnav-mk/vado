import { expect, test } from "vite-plus/test";
import { command } from "../protocol/resp";
import { Pending } from "./pending";
import { EXEC, MULTI } from "./replies-text";

const enc = new TextEncoder();

test("a lost socket's transaction is dropped up to its EXEC; the rest is resent after the setup", () => {
  const pending = new Pending(),
    got: string[] = [];

  const cb = (name: string) => () => got.push(name);

  const set = command(["SET", "k", "v"]),
    get = command(["GET", "k"]);

  pending.add(cb("multi"), MULTI, 1);
  pending.add(cb("set"), set, 1);
  pending.add(cb("exec"), EXEC, 1);
  pending.add(cb("get"), get, 2);
  expect(pending.dropTransaction(), "no MULTI has run yet").toEqual([]);

  pending.next()?.(enc.encode("+OK\r\n"));
  expect(got).toEqual(["multi"]);

  const dropped = pending.dropTransaction();
  expect(dropped.length, "SET and EXEC").toBe(2);
  expect(pending.length).toBe(1);

  const hello = command(["HELLO", "3"]),
    out = pending.resend([hello], 5);

  expect(out).toEqual([hello, get]);
  expect(pending.oldest).toBe(5);
  pending.next();
  pending.next()?.(enc.encode("$1\r\nv\r\n"));
  expect(got, "the setup's reply goes nowhere").toEqual(["multi", "get"]);
});
