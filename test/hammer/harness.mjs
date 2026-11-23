import { api, redis, sleep } from "../lib.mjs";

export const env = process.env;
export const CHAOS = env.CHAOS === "1";
const DB = env.DB ?? "hammer";

export const C = Number(env.C ?? 16),
  SECONDS = Number(env.SECONDS ?? 20);

export const results = [];
export const errors = {}; // error message -> count, across all checks

export const note = (e) => {
  const k = String(e?.message ?? e).slice(0, 60);
  errors[k] = (errors[k] ?? 0) + 1;
};

export const R = (o = {}) =>
  redis(DB, {
    maxRetriesPerRequest: 2,
    retryStrategy: (n) => Math.min(n * 100, 2000),
    enableAutoPipelining: false,
    // A command in flight when the connection drops may have run; resending it could apply it twice.
    autoResendUnfulfilledCommands: false,
    commandTimeout: Number(env.CMD_TIMEOUT ?? 60000), // a stall becomes a counted error, not a hang
    ...o,
  });

// Runs `op` on every client for `ms`; a failed call (LOST, reconnect) may or may not have applied.
export async function race(clients, ms, op) {
  let acked = 0,
    failed = 0;

  const end = Date.now() + ms;
  await Promise.all(
    clients.map(async (c) => {
      while (Date.now() < end) {
        try {
          await op(c);
          acked++;
        } catch (e) {
          note(e);
          failed++;
        }
      }
    }),
  );

  return { acked, failed };
}

// Setup and final reads retry: under chaos a single LOST shouldn't fail a whole check.
export const retry = async (f, n = 40) => {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= n) throw e;
      await sleep(250);
    }
  }
};

export function check(name, ok, detail) {
  results.push({ ...detail, name, passed: ok }); // details may have their own `ok` (a count)
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
}

export const chaosState = { runs: 0, stop: false };

export async function chaos() {
  let db;

  while (!db && !chaosState.stop)
    db = await api(`/db?db=${DB}`).then(
      (r) => r.db,
      () => sleep(1000),
    );

  while (!chaosState.stop) {
    await sleep(3000 + Math.random() * 3000);

    if (chaosState.stop) break;
    const which = Math.random() < 0.2 ? "all" : String(Math.floor(Math.random() * db.shards));
    await api(`/abort?db=${DB}&shard=${which}`).catch(() => {});
    chaosState.runs++;
  }
}
