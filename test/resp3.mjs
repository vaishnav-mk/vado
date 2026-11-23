// RESP3 through the router: HELLO 3, maps, pub/sub pushes, normal commands while subscribed. HOST, PORT, PW, DB.
import assert from "node:assert/strict";
import { enc, PW, sleep, tcp } from "./lib.mjs";

function client() {
  const s = tcp();
  let buf = "";
  s.on("data", (d) => {
    buf += d;
  });

  if (PW) {
    s.write(enc(["AUTH", process.env.DB ?? "default", PW]));
    auths.push(s);
  }

  return {
    send: (...cmds) => s.write(cmds.map(enc).join("")),
    until: async (pred, ms = 3000) => {
      const t0 = Date.now();

      while (!pred(buf)) {
        if (Date.now() - t0 > ms) throw new Error(`timeout; got ${JSON.stringify(buf)}`);
        await sleep(10);
      }

      return buf;
    },
    take: () => {
      const b = buf;
      buf = "";

      return b;
    },
    end: () => s.end(),
  };
}

const auths = [];

const sub = client(),
  pub = client();

if (auths.length) {
  await sub.until((b) => b.startsWith("+OK\r\n"));
  sub.take();
  await pub.until((b) => b.startsWith("+OK\r\n"));
  pub.take();
}

const k = `r3:${Date.now()}`;

sub.send(["HELLO", "3"]);

await sub.until((b) => b.startsWith("%") && /valkey|redis/.test(b));

sub.take();

sub.send(["SUBSCRIBE", "news"], ["SET", k, "1"], ["GET", k], ["HSET", `${k}h`, "a", "1"], ["HGETALL", `${k}h`]);

const got = await sub.until((b) => b.includes(">3\r\n$9\r\nsubscribe") && b.includes("%1\r\n"));

assert.match(got, /\+OK\r\n\$1\r\n1\r\n:1\r\n%1\r\n\$1\r\na\r\n\$1\r\n1\r\n/);

sub.take();

pub.send(["PUBLISH", "news", "hello"]);

await pub.until((b) => b.includes(":1\r\n"));

const push = await sub.until((b) => b.includes("hello"));

assert.match(push, />3\r\n\$7\r\nmessage\r\n\$4\r\nnews\r\n\$5\r\nhello\r\n/);

sub.end();

pub.end();

console.log("resp3 passed");
