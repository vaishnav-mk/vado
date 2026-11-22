// The RESP parser on its own (no runtime needed): requests and replies that arrive in pieces parse the same as
// whole ones, and resuming keeps a huge pipeline linear. node test/resp.mjs
import assert from "node:assert/strict";
import { command, concat, frameEnd, request } from "../src/protocol/resp.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

// Feeds `bytes` in `size`-byte chunks the way the router does: each time, the unparsed tail starts a new buffer
// (here a view, so the test itself stays linear), and the same resume object goes with the frame until it is whole.
function chunked(bytes, size, parse) {
  const out = [], resume = {};
  let base = 0;
  for (let top = Math.min(size, bytes.length); ; top = Math.min(top + size, bytes.length)) {
    const buf = bytes.subarray(base, top);
    let start = 0;
    for (let r; (r = parse(buf, start, resume)); start = r.end) out.push(r.value);
    base += start;
    if (top === bytes.length) break;
  }
  assert.equal(base, bytes.length, "everything parsed");
  return out;
}
const req = (b, i, resume) => { const r = request(b, i, b.length, Infinity, resume); return r && { end: r.end, value: r.argv.map((a) => dec.decode(a)) }; };
const frame = (b, i, resume) => { const e = frameEnd(b, i, b.length, resume); return e >= 0 && { end: e, value: dec.decode(b.subarray(i, e)) }; };

// Requests: a few small ones and a big MSET, in pieces of every size.
const big = ["MSET", ...Array.from({ length: 2000 }, (_, i) => [`k${i}`, `v${i}`]).flat()];
const cmds = [["PING"], ["SET", "a", "x".repeat(5000)], big, ["GET", "a"]];
const pipeline = concat(cmds.map(command));
for (const size of [1, 7, 100, 4096, pipeline.length]) assert.deepEqual(chunked(pipeline, size, req), cmds, `requests in ${size}-byte pieces`);

// Replies: nested arrays, a map and an attribute, in pieces.
const replies = ["*3\r\n:1\r\n*2\r\n$1\r\na\r\n$-1\r\n+OK\r\n", "%2\r\n+k\r\n:1\r\n+j\r\n*1\r\n:2\r\n", "|1\r\n+ttl\r\n:3\r\n$2\r\nhi\r\n", `*500\r\n${"$3\r\nabc\r\n".repeat(500)}`];
const replyBytes = enc.encode(replies.join(""));
for (const size of [1, 5, 64, replyBytes.length]) assert.deepEqual(chunked(replyBytes, size, frame), replies, `replies in ${size}-byte pieces`);

// Linear: 200k arguments in 1 KB pieces. Without resuming, each piece re-parses everything before it (~30 s).
const huge = command(["MSET", ...Array.from({ length: 200_000 }, (_, i) => String(i))]);
let t = performance.now();
assert.equal(chunked(huge, 1024, req)[0].length, 200_001);
const reqMs = performance.now() - t;
const hugeReply = enc.encode(`*200000\r\n${":1\r\n".repeat(200_000)}`);
t = performance.now();
assert.equal(chunked(hugeReply, 1024, frame).length, 1);
const replyMs = performance.now() - t;
assert.ok(reqMs < 3000 && replyMs < 3000, `200k arguments took ${reqMs.toFixed(0)} ms, a 200k-element reply ${replyMs.toFixed(0)} ms`);
console.log("resp passed");
