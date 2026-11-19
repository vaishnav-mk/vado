// RESP3 through the router: HELLO 3, map replies, pushes for pub/sub, normal commands while subscribed.
import net from "node:net";
import assert from "node:assert/strict";

const enc = (a) => `*${a.length}\r\n` + a.map((x) => `$${Buffer.byteLength(x)}\r\n${x}\r\n`).join("");
function client() {
  const s = net.connect(Number(process.env.PORT ?? 6380), "127.0.0.1");
  let buf = "";
  s.on("data", (d) => { buf += d; });
  // PW/DB: authenticate first (prod through scripts/ws-shim.mjs); the +OK is consumed below.
  if (process.env.PW) { s.write(enc(["AUTH", process.env.DB ?? "default", process.env.PW])); auths.push(s); }
  return {
    send: (...cmds) => s.write(cmds.map(enc).join("")),
    until: async (pred, ms = 3000) => { const t0 = Date.now(); while (!pred(buf)) { if (Date.now() - t0 > ms) throw new Error(`timeout; got ${JSON.stringify(buf)}`); await new Promise((r) => setTimeout(r, 10)); } return buf; },
    take: () => { const b = buf; buf = ""; return b; },
    end: () => s.end(),
  };
}
const auths = [];
const sub = client(), pub = client();
if (auths.length) { await sub.until((b) => b.startsWith("+OK\r\n")); sub.take(); await pub.until((b) => b.startsWith("+OK\r\n")); pub.take(); }
const k = `r3:${Date.now()}`;
sub.send(["HELLO", "3"]);
await sub.until((b) => b.startsWith("%") && b.includes("valkey"));
sub.take();
sub.send(["SUBSCRIBE", "news"], ["SET", k, "1"], ["GET", k], ["HSET", `${k}h`, "a", "1"], ["HGETALL", `${k}h`]);
const got = await sub.until((b) => b.includes(">3\r\n$9\r\nsubscribe") && b.includes("%1\r\n"));
assert.match(got, /\+OK\r\n\$1\r\n1\r\n:1\r\n%1\r\n\$1\r\na\r\n\$1\r\n1\r\n/); // normal replies in order, RESP3 map
sub.take();
pub.send(["PUBLISH", "news", "hello"]);
await pub.until((b) => b.includes(":1\r\n"));
const push = await sub.until((b) => b.includes("hello"));
assert.match(push, />3\r\n\$7\r\nmessage\r\n\$4\r\nnews\r\n\$5\r\nhello\r\n/);
sub.end(); pub.end();
console.log("resp3 passed");
