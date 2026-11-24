import { expect, test } from "vite-plus/test";
import { request } from "../../src/protocol/request";
import { bulk, bulkBytes, bulkText, command, concat, elements, error, frameEnd, lower } from "../../src/protocol/resp";
import type { FrameResume, RequestResume } from "../../src/protocol/types";

const enc = new TextEncoder();
const dec = new TextDecoder();

type Parse<T> = (b: Uint8Array, i: number, resume: FrameResume & RequestResume) => { end: number; value: T } | null;

// As the router feeds them: the unparsed tail starts each buffer (a view here, so the test stays linear).
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

test("encoders and helpers", () => {
  expect(dec.decode(error("ERR a\r\nb"))).toBe("-ERR a  b\r\n");
  expect(dec.decode(bulk(null))).toBe("$-1\r\n");
  expect(dec.decode(bulk(42))).toBe("$2\r\n42\r\n");
  expect(elements(enc.encode("*2\r\n:1\r\n$1\r\nx\r\n")).map((e) => dec.decode(e))).toEqual([":1\r\n", "$1\r\nx\r\n"]);
  expect(lower(enc.encode("GeT"))).toBe("get");
  expect(lower(enc.encode("X".repeat(70)))).toBe("x".repeat(70));
  expect(dec.decode(bulkBytes(bulk("hello")))).toBe("hello");
  expect(bulkText(bulk("a\r\nb"))).toBe("a\r\nb");
  expect(bulkText(bulk(null))).toBe("");
  expect(bulkText(enc.encode("-ERR x\r\n")), "not a bulk string").toBe("");
});
