// Load generator for ui/server.mjs, run as a child process so it can't stall the latency probe.
// argv: host port db password conns depth mix(reads|writes|both) keyspace. Reports the last second's
// { ops, errors, lastError } to the parent every second; exits on "stop".
import Redis from "ioredis";

const [host, port, db, password, conns, depth, mix, keyspace] = process.argv.slice(2);
const N = Number(conns), D = Number(depth), K = Number(keyspace);
let ops = 0, errors = 0, lastError = null, stop = false;
const value = "v".repeat(32);

async function worker(i) {
  const c = new Redis({ host, port: Number(port), username: db, password, maxRetriesPerRequest: 0, lazyConnect: true });
  c.on("error", () => {});
  try { await c.connect(); } catch (e) { errors++; lastError = e.message; return; }
  while (!stop) {
    const p = c.pipeline();
    for (let k = 0; k < D; k++) {
      const key = `load:${Math.floor(Math.random() * K)}`;
      const write = mix === "writes" || (mix === "both" && Math.random() < 0.5);
      if (write) p.set(key, value); else p.get(key);
    }
    try {
      for (const [e] of await p.exec()) { if (e) { errors++; lastError = e.message; } else ops++; }
    } catch (e) { errors++; lastError = e.message; await new Promise((r) => setTimeout(r, 200)); }
  }
  c.disconnect();
}

const workers = Array.from({ length: N }, (_, i) => worker(i));
const tick = setInterval(() => { process.send({ ops, errors, lastError }); ops = 0; errors = 0; lastError = null; }, 1000);
process.on("message", async (m) => {
  if (m !== "stop") return;
  stop = true;
  await Promise.allSettled(workers);
  clearInterval(tick);
  process.exit(0);
});
process.on("disconnect", () => process.exit(0));
