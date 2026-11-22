// Queues and pub/sub: a reliable BLMOVE queue, and every published message received.
import { C, CHAOS, check, note, R, retry, sleep } from "./harness.mjs";

// Reliable-queue pattern: BLMOVE into a per-consumer processing list in the same slot, so a pop
// whose reply is lost (shard reset after the move) leaves the item in that list, not gone. Every
// acknowledged push must end up consumed, in a processing list, or still queued.
export async function queue() {
  const P = Math.max(2, C / 2),
    Q = Math.max(2, C / 2),
    q = `queue:{q}`,
    PER = 200;

  const proc = (i) => `queue:{q}:processing:${i}`;
  const clients = Array.from({ length: P + Q + 1 }, () => R());
  await retry(() => clients[0].del(q, ...Array.from({ length: Q }, (_, i) => proc(i))));

  const pushed = new Set(),
    pushFailed = new Set(),
    got = [];

  let popFailed = 0,
    done = false;

  const producers = clients.slice(1, P + 1).map(async (c, p) => {
    for (let i = 0; i < PER; i++) {
      const id = `${p}:${i}`;

      try {
        await c.lpush(q, id);
        pushed.add(id);
      } catch (e) {
        note(e);
        pushFailed.add(id);
      }
    }
  });

  const consumers = clients.slice(P + 1).map(async (c, i) => {
    while (!done) {
      try {
        const id = await c.blmove(q, proc(i), "RIGHT", "LEFT", 1);

        if (id) {
          got.push(id);
          await c.lrem(proc(i), 1, id);
        } // processed: acknowledge
      } catch (e) {
        note(e);
        popFailed++;
      }
    }
  });

  await Promise.all(producers);
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline && (await clients[0].llen(q).catch(() => 1)) > 0) await sleep(200);
  await sleep(1500);
  done = true;
  await Promise.all(consumers);

  const inFlight = (
    await Promise.all(Array.from({ length: Q }, (_, i) => retry(() => clients[0].lrange(proc(i), 0, -1))))
  ).flat();

  const left = await retry(() => clients[0].lrange(q, 0, -1));
  const seen = new Set([...got, ...inFlight, ...left]);
  const lost = [...pushed].filter((x) => !seen.has(x));
  check("queue loses no acknowledged item", lost.length === 0, {
    total: P * PER,
    pushed: pushed.size,
    pushFailed: pushFailed.size,
    consumed: got.length,
    uniqueConsumed: new Set(got).size,
    inProcessing: inFlight.length,
    stillQueued: left.length,
    popFailed,
    lost: lost.length,
    lostSample: lost.slice(0, 5),
  });
  clients.forEach((c) => c.disconnect());
}

export async function pubsub() {
  const S = Math.min(C, 32),
    M = 300;

  const subs = Array.from({ length: S }, () => R());
  const pub = R();
  const seen = subs.map(() => []);
  await Promise.all(
    subs.map((s, i) => {
      s.on("message", (_ch, m) => seen[i].push(Number(m)));

      return retry(() => s.subscribe("fan:{p}"));
    }),
  );
  await sleep(300);
  let sent = 0;

  for (let i = 0; i < M; i++) {
    try {
      await pub.publish("fan:{p}", String(i));
      sent++;
    } catch (e) {
      note(e); /* counted below */
    }
  }

  await sleep(2000);
  const complete = seen.filter((xs) => xs.length === M).length;
  const ordered = seen.every((xs) => xs.every((v, k) => k === 0 || v > xs[k - 1]));
  // Under chaos a subscriber whose pub/sub object was reset misses messages (pub/sub is fire-and-forget).
  check("pub/sub fan-out is complete and ordered", ordered && (CHAOS || complete === S), {
    subscribers: S,
    sent,
    complete,
    ordered,
  });
  [...subs, pub].forEach((c) => c.disconnect());
}
