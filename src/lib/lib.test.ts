import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { replicationLine, showArgv, showReply, splitArgs, toArgv } from "./command";
import { axisLabel, niceAxis } from "./format";

test("splitArgs", () => {
  assert.deepEqual(splitArgs(`SET "my key" 'it is' x`), ["SET", "my key", "it is", "x"]);
  assert.deepEqual(splitArgs(`  GET   a  `), ["GET", "a"]);
  assert.deepEqual(splitArgs(`SET k "a\\"b\\n\\x41"`), ["SET", "k", 'a"b\nA']);
  assert.deepEqual(splitArgs(`SET k 'a\\'b\\n'`), ["SET", "k", "a'b\\n"]);
  assert.deepEqual(splitArgs(`SET k ""`), ["SET", "k", ""]);
  assert.throws(() => splitArgs(`SET k "open`));
  assert.throws(() => splitArgs(`SET k "a"b`));
});

test("toArgv", () => {
  assert.deepEqual(toArgv("SET", ["greeting", "hello world"]), ["SET", "greeting", "hello world"]);
  assert.deepEqual(toArgv("DEL", ['a "b c"']), ["DEL", "a", "b c"]);
  assert.deepEqual(toArgv("DBSIZE", []), ["DBSIZE"]);
  assert.deepEqual(toArgv("Other", ["hset h f v"]), ["hset", "h", "f", "v"]);
});

test("showArgv and showReply", () => {
  assert.equal(showArgv(["SET", "my key", "v"]), `SET "my key" v`);
  assert.equal(showReply({ type: "status", value: "OK" }), "OK");
  assert.equal(showReply({ type: "bulk", value: "OK" }), `"OK"`); // GET of a key holding OK, quoted as valkey-cli does
  assert.equal(showReply({ type: "bulk", value: "hello" }), `"hello"`);
  assert.equal(showReply({ type: "nil" }), "(nil)");
  assert.equal(showReply({ type: "integer", value: 3 }), "(integer) 3");
  assert.equal(showReply({ type: "error", value: "ERR nope" }), "(error) ERR nope");
  assert.equal(showReply({ type: "array", value: [] }), "(empty array)");
  assert.equal(
    showReply({
      type: "array",
      value: [
        { type: "bulk", value: "a" },
        {
          type: "array",
          value: [
            { type: "bulk", value: "b" },
            { type: "integer", value: 2 },
          ],
        },
      ],
    }),
    `1) "a"\n2) 1) "b"\n   2) (integer) 2`,
  );
});

test("chart axes never repeat a label", () => {
  for (const [top, minStep] of [
    [0, 0.1],
    [0.3, 0.1],
    [2.4, 0.1],
    [7, 1],
    [13, 1],
    [999, 1],
    [1234, 1],
    [12500, 1],
    [99999, 1],
    [3.2e6, 1],
    [410, 1],
  ]) {
    const { max, step } = niceAxis(top, minStep),
      labels: string[] = [];

    for (let k = 0; k * step <= max + 1e-9; k++) labels.push(axisLabel(k * step, step));
    assert.ok(max >= top);
    assert.equal(new Set(labels).size, labels.length, `${top}: ${labels.join(" ")}`);
  }

  assert.equal(axisLabel(1500, 500), "1.5K");
  assert.equal(axisLabel(0.2, 0.1), "0.2");
});

test("replicationLine only says copied when the replicas were ready", () => {
  const rep = { acked: 0, of: 9, ms: 76 };
  assert.equal(
    replicationLine(rep, Array(9).fill("asleep")),
    "Its 9 replicas were asleep; this write wakes them, and they catch up in a few seconds.",
  );
  assert.equal(
    replicationLine({ acked: 9, of: 9, ms: 410 }, Array(9).fill("ready")),
    "Copied to all 9 replicas in 410 ms.",
  );
  assert.equal(
    replicationLine({ acked: 2, of: 9, ms: 50 }, [...Array(3).fill("ready"), ...Array(6).fill("asleep")]),
    "Copied to 2 of the 3 ready replicas in 50 ms. The other 6 weren't ready and catch up in a few seconds.",
  );
  assert.match(replicationLine(rep, Array(9).fill("copying")), /still copying/);
});
