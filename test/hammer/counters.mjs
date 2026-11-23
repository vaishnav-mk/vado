import { C, check, R, race, retry, SECONDS } from "./harness.mjs";

export async function incr() {
  const clients = Array.from({ length: C }, () => R());
  const key = `incr:{c}`;
  await retry(() => clients[0].del(key));
  const { acked, failed } = await race(clients, (SECONDS * 1000) / 4, (c) => c.incr(key));
  const final = Number(await retry(() => clients[0].get(key)));
  check("concurrent INCR is exact", final >= acked && final <= acked + failed, { acked, failed, final });
  clients.forEach((c) => c.disconnect());
}

export async function bank() {
  const N = 10,
    START = 1000,
    key = (i) => `acct:{bank}:${i}`;

  const clients = Array.from({ length: C }, () => R());
  await retry(() => clients[0].mset(...Array.from({ length: N }, (_, i) => [key(i), START]).flat()));

  let commits = 0,
    conflicts = 0;

  const { failed } = await race(clients, (SECONDS * 1000) / 4, async (c) => {
    const a = Math.floor(Math.random() * N),
      b = (a + 1 + Math.floor(Math.random() * (N - 1))) % N,
      amt = 1 + Math.floor(Math.random() * 10);

    await c.watch(key(a), key(b));
    const [x, y] = (await c.mget(key(a), key(b))).map(Number);

    if (x < amt) return await c.unwatch();

    const r = await c
      .multi()
      .set(key(a), x - amt)
      .set(key(b), y + amt)
      .exec();

    if (r === null) conflicts++;
    else commits++;
  });

  const vals = (await retry(() => clients[0].mget(...Array.from({ length: N }, (_, i) => key(i))))).map(Number);
  const sum = vals.reduce((s, v) => s + v, 0);
  check("WATCH/MULTI transfers conserve money", sum === N * START && vals.every((v) => v >= 0), {
    sum,
    expected: N * START,
    commits,
    conflicts,
    failed,
  });
  clients.forEach((c) => c.disconnect());
}

export async function lua() {
  const clients = Array.from({ length: C }, () => R());
  const h = "lua:{h}";
  await retry(() => clients[0].del(h));

  const script =
    "local a = redis.call('HINCRBY', KEYS[1], 'a', 1); local b = redis.call('HINCRBY', KEYS[1], 'b', 1); return a - b";

  let skew = 0;

  const { acked, failed } = await race(clients, (SECONDS * 1000) / 8, async (c) => {
    if ((await c.eval(script, 1, h)) !== 0) skew++;
  });

  const { a, b } = await retry(() => clients[0].hgetall(h));
  check("Lua scripts are atomic", skew === 0 && a === b && Number(a) >= acked && Number(a) <= acked + failed, {
    acked,
    failed,
    a,
    b,
    skew,
  });
  clients.forEach((c) => c.disconnect());
}
