// Requests in tiny pieces must parse whole, and large frames must cost linear, not quadratic, copying.
// HOST, PORT, PW, DB.
import assert from "node:assert/strict";
import { enc, PW, sleep, tcp } from "./lib.mjs";

const s = tcp();

s.setNoDelay(true);

let buf = "";

s.on("data", (d) => {
  buf += d.toString("latin1");
});

const until = async (n, ms = 20000) => {
  const t0 = Date.now();

  while (buf.length < n) {
    if (Date.now() - t0 > ms) throw new Error(`timeout; got ${buf.length}/${n} bytes`);
    await sleep(10);
  }
};

const write = (b) => new Promise((r) => s.write(b, () => setImmediate(r)));

await new Promise((r) => s.on("connect", r));

if (PW) {
  await write(enc(["AUTH", process.env.DB ?? "default", PW]));
  await until(5);
  assert.equal(buf, "+OK\r\n");
  buf = "";
}

const k = `chunked:${Date.now()}`;

const values = [
  ["a", "1"],
  ["b", "two"],
  ["big", Array.from({ length: 300 << 10 }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join("")],
  ["c", "after-big"],
];

const payload = Buffer.from(
  values.map(([n, v]) => enc(["SET", `${k}:${n}`, v])).join("") +
    values.map(([n]) => enc(["GET", `${k}:${n}`])).join(""),
  "latin1",
);

const expected = values.map(() => "+OK\r\n").join("") + values.map(([, v]) => `$${v.length}\r\n${v}\r\n`).join("");
const sizes = [1, 3, 7, 4096, 2, 4096, 4096];

for (let i = 0, j = 0; i < payload.length; j++) {
  const n = sizes[j % sizes.length];
  await write(payload.subarray(i, i + n));
  i += n;
}

await until(expected.length);

assert.equal(buf.length, expected.length);

assert.ok(buf === expected, "replies differ from what was written");

// 8 MB in 4 KB pieces takes well under a second; re-copying the partial frame per chunk took many seconds.
buf = "";

const mb8 = Buffer.alloc(8 << 20, 113);
const t0 = performance.now();
const key8 = `${k}:8m`;

await write(`*3\r\n$3\r\nSET\r\n$${key8.length}\r\n${key8}\r\n$${mb8.length}\r\n`);

for (let i = 0; i < mb8.length; i += 4 << 10) await write(mb8.subarray(i, i + (4 << 10)));

await write("\r\n");

await until(5);

assert.equal(buf, "+OK\r\n");

const ms = performance.now() - t0;

assert.ok(ms < 3000 || process.env.HOST, `8 MB SET took ${ms.toFixed(0)} ms`);

s.end();

console.log(`chunked passed; 8 MB SET in 4 KB pieces took ${ms.toFixed(0)} ms`);
