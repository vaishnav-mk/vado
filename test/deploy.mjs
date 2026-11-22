// What clients see during a deploy. CONNS connections per database loop over INCR (a write), GET of their own
// key (read-your-writes) and GET of a prefilled key (a replica read), for SECONDS; deploy meanwhile, from
// another shell. Prints errors in 5 s buckets, the slowest replies, and checks every counter:
// acked <= final <= acked + lost (a LOST INCR may or may not have run). Exits 1 if a counter is off.
// Usage: HOST=<host> [PORT=6379] PW=<password> [SECONDS=240] [CONNS=16] node test/deploy.mjs db1 [db2 ...]
import net from "node:net";
const { HOST, PORT = "6379", PW, SECONDS = "240", CONNS = "16" } = process.env;
const dbs = process.argv.slice(2), end = Date.now() + Number(SECONDS) * 1000, t0 = Date.now();
const enc = (a) => `*${a.length}\r\n` + a.map((x) => `$${Buffer.byteLength(x)}\r\n${x}\r\n`).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The end of the RESP frame at i, or -1 if it isn't all here yet.
function frameEnd(b, i) {
  const le = b.indexOf("\r\n", i);
  if (le < 0) return -1;
  const t = b[i], n = Number(b.subarray(i + 1, le));
  if (t === 36) return n < 0 ? le + 2 : b.length >= le + 4 + n ? le + 4 + n : -1; // $
  if (t === 42) { let j = le + 2; for (let k = 0; k < n; k++) { j = frameEnd(b, j); if (j < 0) return -1; } return j; } // *
  return le + 2;
}

// One reply at a time per connection.
function open(db) {
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(PORT), HOST);
    s.setNoDelay(true);
    let buf = Buffer.alloc(0), want = null, closed = false;
    const tryReply = () => {
      if (!want) return;
      const end = frameEnd(buf, 0);
      if (end < 0) return;
      const line = buf.subarray(0, end).toString();
      buf = buf.subarray(end);
      const w = want; want = null; w.res(line);
    };
    s.on("data", (d) => { buf = Buffer.concat([buf, d]); tryReply(); });
    const fail = (e) => { closed = true; if (want) { const w = want; want = null; w.rej(e); } };
    s.on("error", fail); s.on("close", () => fail(new Error("closed")));
    const cmd = (a) => closed ? Promise.reject(new Error("closed")) : new Promise((res, rej) => { want = { res, rej }; s.write(enc(a)); });
    s.on("connect", async () => {
      try { const r = await cmd(["AUTH", db, PW]); if (!r.startsWith("+OK")) throw new Error(r.trim()); resolve({ cmd, close: () => s.destroy() }); } catch (e) { reject(e); }
    });
    s.setTimeout(15000, () => { s.destroy(new Error("timeout")); });
  });
}

const buckets = new Map(), slow = [];
const note = (db, kind) => { const b = Math.floor((Date.now() - t0) / 5000) * 5; const k = `${b}`; const m = buckets.get(k) ?? {}; m[`${db} ${kind}`] = (m[`${db} ${kind}`] ?? 0) + 1; buckets.set(k, m); };

async function worker(db, id) {
  const key = `dl:${id}`, st = { acked: 0, lost: 0, reconnects: 0 };
  let c = null;
  while (Date.now() < end) {
    try {
      if (!c) { c = await open(db); }
      for (const a of [["INCR", key], ["GET", key], ["GET", `ro:${id % 50}`]]) {
        const t = Date.now(), r = await c.cmd(a), ms = Date.now() - t;
        if (ms > 1000) slow.push([Math.round((t - t0) / 1000), db, a[0], ms]);
        if (r.startsWith("-")) {
          note(db, `${a[0]} ${r.slice(1, 30).trim()}`);
          if (a[0] === "INCR") st.lost++;
          continue;
        }
        if (a[0] === "INCR") { st.acked = Number(r.slice(1)); note(db, "ok"); }
        if (a[0] === "GET" && a[1] === key && Number(r.split("\r\n")[1]) < st.acked) note(db, "STALE own read");
      }
    } catch (e) {
      note(db, `conn ${e.message.slice(0, 30)}`);
      c?.close(); c = null; st.reconnects++;
      await sleep(500);
    }
  }
  c?.close();
  return st;
}

for (const db of dbs) { const c = await open(db); for (let i = 0; i < 50; i++) await c.cmd(["SET", `ro:${i}`, "x"]); for (let i = 0; i < Number(CONNS); i++) await c.cmd(["DEL", `dl:${db}:${i}`]); c.close(); }
const results = await Promise.all(dbs.flatMap((db) => Array.from({ length: Number(CONNS) }, (_, i) => worker(db, `${db}:${i}`).then((st) => ({ db, id: `${db}:${i}`, ...st })))));

// Final counters, read on the primary (MULTI runs there).
let bad = 0;
for (const db of dbs) {
  const c = await open(db);
  for (const r of results.filter((x) => x.db === db)) {
    await c.cmd(["MULTI"]); await c.cmd(["GET", `dl:${r.id}`]); const ex = await c.cmd(["EXEC"]);
    const v = Number(ex.split("\r\n")[2] ?? -1);
    if (!(v >= r.acked && v <= r.acked + r.lost)) { bad++; console.log("COUNTER MISMATCH", r.id, { final: v, acked: r.acked, lost: r.lost }); }
  }
  c.close();
}
for (const [k, m] of [...buckets].sort((a, b) => a[0] - b[0])) {
  const errs = Object.entries(m).filter(([n]) => !n.endsWith(" ok"));
  const oks = Object.entries(m).filter(([n]) => n.endsWith(" ok")).map(([n, v]) => `${n.split(" ")[0]} ${v}`).join(", ");
  console.log(`${String(k).padStart(4)}s  ok: ${oks}${errs.length ? "  ERR " + errs.map(([n, v]) => `${n}: ${v}`).join("; ") : ""}`);
}
console.log("slowest", slow.sort((a, b) => b[3] - a[3]).slice(0, 8));
console.log(JSON.stringify({ counters: results.length, mismatched: bad, lost: results.reduce((s, r) => s + r.lost, 0), reconnects: results.reduce((s, r) => s + r.reconnects, 0) }));
process.exit(bad ? 1 : 0);
