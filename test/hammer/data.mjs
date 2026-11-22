// Data shapes: sorted sets, big values, expiry, pipelines and key churn.
import crypto from "node:crypto";
import { C, CHAOS, check, env, note, R, retry, SECONDS, sleep, until } from "./harness.mjs";

export async function zset() {
  const clients = Array.from({ length: C }, () => R());

  const z = "lb:{z}",
    members = 50;

  await retry(() => clients[0].del(z));

  let acked = 0,
    failed = 0;

  const go = until((SECONDS * 1000) / 8);
  await Promise.all(
    clients.map(async (c) => {
      while (go()) {
        try {
          await c.zincrby(z, 1, `m${Math.floor(Math.random() * members)}`);
          acked++;
        } catch (e) {
          note(e);
          failed++;
        }
      }
    }),
  );
  const all = await retry(() => clients[0].zrange(z, 0, -1, "WITHSCORES"));
  let sum = 0;

  for (let i = 1; i < all.length; i += 2) sum += Number(all[i]);
  check("sorted-set increments add up", sum >= acked && sum <= acked + failed, { acked, failed, sum });
  clients.forEach((c) => c.disconnect());
}

export async function bigValues() {
  const c = R({ maxRetriesPerRequest: 0 });
  const out = {};
  let ok = true;

  for (const mb of [1, 4, 8]) {
    const v = crypto.randomBytes(mb << 20);
    const key = `big:${mb}`;

    try {
      await c.set(key, v);
      const back = await c.getBuffer(key);
      const same = Buffer.compare(v, back) === 0;
      out[`${mb}MB`] = same ? "ok" : "MISMATCH";
      ok &&= same;
      await c.del(key);
    } catch (e) {
      out[`${mb}MB`] = e.message.slice(0, 80);
      ok &&= CHAOS;
    }
  }

  // Over the request limit: refused up front (this connection only), not a shard reset for everyone.
  const over = R({ maxRetriesPerRequest: 0, retryStrategy: () => null });
  over.on("error", () => {});
  out["16MB"] = await over.set("big:16", crypto.randomBytes(16 << 20)).then(
    () => "accepted",
    (e) => e.message.slice(0, 60),
  );
  ok &&=
    /invalid bulk length|ECONNRESET|EPIPE|Connection is closed/.test(out["16MB"]) ||
    (CHAOS && /shard connection lost/.test(out["16MB"]));
  over.disconnect();
  check("large values round-trip", ok, out);
  c.disconnect();
}

export async function expiry() {
  const c = R();
  const n = 200;
  const p = c.pipeline();

  // 2 s: long enough for the first MGET's retries under chaos (a shard reset between the SETs and the MGET)
  for (let i = 0; i < n; i++) p.set(`exp:${i}`, "x", "PX", 2000);
  await p.exec();
  const live = (await retry(() => c.mget(...Array.from({ length: n }, (_, i) => `exp:${i}`)))).filter(Boolean).length;
  await sleep(3000);
  const left = (await retry(() => c.mget(...Array.from({ length: n }, (_, i) => `exp:${i}`)))).filter(Boolean).length;
  check("PX expiry", left === 0 && live > 0, { setThenLive: live, afterExpiry: left });
  c.disconnect();
}

export async function pipelines() {
  const c = R();

  const n = 20000,
    p = c.pipeline();

  for (let i = 0; i < n; i++) {
    if (i % 4 === 0) p.set(`pl:${i}`, String(i));
    else if (i % 4 === 1) p.get(`pl:${i - 1}`);
    else if (i % 4 === 2) p.hset(`plh:{${i % 97}}`, `f${i}`, String(i));
    else p.sadd(`pls:{${i % 89}}`, String(i));
  }

  const t0 = Date.now();
  const r = await p.exec();
  const ms = Date.now() - t0;
  const errors = r.filter(([e]) => e).length;
  // Under chaos a command may fail, but only as LOST; a GET that worked after its SET worked must see it.
  const lostOnly = r.every(([e]) => !e || /shard connection lost|Connection is closed/.test(e.message));
  const getsOk = r.every(([e, v], i) => i % 4 !== 1 || e || r[i - 1][0] || v === String(i - 1));
  check("20k-command mixed pipeline", (CHAOS ? lostOnly : errors === 0) && getsOk, {
    ms,
    errors,
    opsPerSec: Math.round((n / ms) * 1000),
  });
  c.disconnect();
}

export async function churn() {
  const n = Number(env.CHURN ?? 200);

  let ok = 0,
    bad = 0;

  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const c = R({ maxRetriesPerRequest: 0, retryStrategy: () => null, lazyConnect: true });

      try {
        await c.connect();
        await c.set(`churn:${i}`, "1");

        if ((await c.get(`churn:${i}`)) === "1") ok++;
        else bad++;
      } catch (e) {
        note(e);
        bad++;
      }

      c.disconnect();
    }),
  );
  check("connection churn (connect, AUTH, write, read, close)", bad === 0 || CHAOS, {
    connections: n,
    ok,
    bad,
    ms: Date.now() - t0,
  });
}
