// Requests written in tiny pieces and a large value written in 4 KB pieces: the router must rebuild
// frames across chunks (growing its read buffer in place) without corrupting commands it already
// parsed, and large frames must cost linear, not quadratic, copying.
import net from "node:net";
import assert from "node:assert/strict";

const enc = (a) => `*${a.length}\r\n` + a.map((x) => `$${Buffer.byteLength(x)}\r\n${x}\r\n`).join("");
const s = net.connect(Number(process.env.PORT ?? 6380), process.env.HOST ?? "127.0.0.1");
s.setNoDelay(true);
let buf = "";
s.on("data", (d) => { buf += d.toString("latin1"); });
const until = async (n, ms = 20000) => { const t0 = Date.now(); while (buf.length < n) { if (Date.now() - t0 > ms) throw new Error(`timeout; got ${buf.length}/${n} bytes`); await new Promise((r) => setTimeout(r, 10)); } };
const write = (b) => new Promise((r) => s.write(b, () => setImmediate(r)));
await new Promise((r) => s.on("connect", r));
if (process.env.PW) { await write(enc(["AUTH", process.env.DB ?? "default", process.env.PW])); await until(5); assert.equal(buf, "+OK\r\n"); buf = ""; }

const k = `chunked:${Date.now()}`;
const values = [["a", "1"], ["b", "two"], ["big", Array.from({ length: 300 << 10 }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join("")], ["c", "after-big"]];
const payload = Buffer.from(values.map(([n, v]) => enc(["SET", `${k}:${n}`, v])).join("") + values.map(([n]) => enc(["GET", `${k}:${n}`])).join(""), "latin1");
const expected = values.map(() => "+OK\r\n").join("") + values.map(([, v]) => `$${v.length}\r\n${v}\r\n`).join("");
const sizes = [1, 3, 7, 4096, 2, 4096, 4096];
for (let i = 0, j = 0; i < payload.length; j++) { const n = sizes[j % sizes.length]; await write(payload.subarray(i, i + n)); i += n; }
await until(expected.length);
assert.equal(buf.length, expected.length);
assert.ok(buf === expected, "replies differ from what was written");

// Linear copying: a 16 MB value sent in 16 KB pieces round-trips in well under the ~4 s it took when
// every chunk re-copied the whole partial frame.
buf = "";
const mb16 = Buffer.alloc(16 << 20, 113);
const t0 = performance.now();
const key16 = `${k}:16m`;
await write(`*3\r\n$3\r\nSET\r\n$${key16.length}\r\n${key16}\r\n$${mb16.length}\r\n`);
for (let i = 0; i < mb16.length; i += 16 << 10) await write(mb16.subarray(i, i + (16 << 10)));
await write("\r\n");
await until(5);
assert.equal(buf, "+OK\r\n");
const ms = performance.now() - t0;
assert.ok(ms < 3000 || process.env.HOST, `16 MB SET took ${ms.toFixed(0)} ms`);
s.end();
console.log(`chunked passed; 16 MB SET in ${ms.toFixed(0)} ms`);
