// The RESP parser on its own: requests and replies that arrive in pieces parse the same as whole ones, and resuming
// keeps a huge pipeline linear.
import { expect, test } from "vite-plus/test";
import { decodeTyped } from "../../src/protocol/decode";
import { request } from "../../src/protocol/request";
import { command, concat, frameEnd } from "../../src/protocol/resp";
import type { FrameResume, RequestResume } from "../../src/protocol/types";

const enc = new TextEncoder();
const dec = new TextDecoder();

type Parse<T> = (b: Uint8Array, i: number, resume: FrameResume & RequestResume) => { end: number; value: T } | null;

// Feeds `bytes` in `size`-byte chunks the way the router does: each time, the unparsed tail starts a new buffer
// (here a view, so the test itself stays linear), and the same resume object goes with the frame until it is whole.
function chunked<T>(bytes: Uint8Array, size: number, parse: Parse<T>): T[] {
  const out: T[] = [];
  const resume = {};

  let base = 0;

  for (let top = Math.min(size, bytes.length); ; top = Math.min(top + size, bytes.length)) {
    const buf = bytes.subarray(base, top);
    let start = 0;

    for (let r = parse(buf, start, resume); r; r = parse(buf, start, resume)) {
      out.push(r.value);
      start = r.end;
    }

    base += start;

    if (top === bytes.length) break;
  }

  expect(base, "everything parsed").toBe(bytes.length);

  return out;
}

const req: Parse<string[]> = (b, i, resume) => {
  const r = request(b, i, b.length, Infinity, resume);

  return r && { end: r.end, value: r.argv.map((a) => dec.decode(a)) };
};

const frame: Parse<string> = (b, i, resume) => {
  const e = frameEnd(b, i, b.length, resume);

  return e >= 0 ? { end: e, value: dec.decode(b.subarray(i, e)) } : null;
};

test("requests in pieces of every size", () => {
  const big = ["MSET", ...Array.from({ length: 2000 }, (_, i) => [`k${i}`, `v${i}`]).flat()];
  const cmds = [["PING"], ["SET", "a", "x".repeat(5000)], big, ["GET", "a"]];
  const pipeline = concat(cmds.map(command));

  for (const size of [1, 7, 100, 4096, pipeline.length]) expect(chunked(pipeline, size, req)).toEqual(cmds);
});

test("replies of every RESP type in pieces", () => {
  const replies = [
    "*3\r\n:1\r\n*2\r\n$1\r\na\r\n$-1\r\n+OK\r\n",
    "%2\r\n+k\r\n:1\r\n+j\r\n*1\r\n:2\r\n",
    "|1\r\n+ttl\r\n:3\r\n$2\r\nhi\r\n",
    `*500\r\n${"$3\r\nabc\r\n".repeat(500)}`,
  ];

  const bytes = enc.encode(replies.join(""));

  for (const size of [1, 5, 64, bytes.length]) expect(chunked(bytes, size, frame)).toEqual(replies);
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

// Without resuming, each 1 KB piece re-parses everything before it (about 30 s).
test("200k arguments and a 200k-element reply parse in linear time", () => {
  let t = performance.now();
  expect(
    chunked(command(["MSET", ...Array.from({ length: 200_000 }, (_, i) => String(i))]), 1024, req)[0],
  ).toHaveLength(200_001);
  expect(performance.now() - t).toBeLessThan(3000);
  t = performance.now();
  expect(chunked(enc.encode(`*200000\r\n${":1\r\n".repeat(200_000)}`), 1024, frame)).toHaveLength(1);
  expect(performance.now() - t).toBeLessThan(3000);
});
