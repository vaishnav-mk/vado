// What every hammer check shares: settings from the environment, a client, the bench API, retries and results.
import Redis from "ioredis";

export const env = process.env;
export const CHAOS = env.CHAOS === "1"; // CHAOS=1 aborts shards while the checks run

export const PORT = Number(env.PORT ?? 6379),
  PW = env.PW || undefined,
  DB = env.DB ?? "hammer";

export const C = Number(env.C ?? 16),
  SECONDS = Number(env.SECONDS ?? 20);

export const BASE = env.BASE ?? "http://localhost:5173",
  TOKEN = env.TOKEN ?? "local";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const results = [];
export const errors = {}; // error message -> count, across all checks

export const note = (e) => {
  const k = String(e?.message ?? e).slice(0, 60);
  errors[k] = (errors[k] ?? 0) + 1;
};

export const R = (o = {}) =>
  new Redis({
    port: PORT,
    host: env.HOST ?? "127.0.0.1",
    username: PW ? DB : undefined,
    password: PW,
    maxRetriesPerRequest: 2,
    retryStrategy: (n) => Math.min(n * 100, 2000),
    enableAutoPipelining: false,
    // A command in flight when the connection drops may have run; resending it could apply it twice.
    autoResendUnfulfilledCommands: false,
    commandTimeout: Number(env.CMD_TIMEOUT ?? 60000), // a stall becomes a counted error, not a hang
    ...o,
  });

export const api = (path) =>
  fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());

export const until = (ms) => {
  const end = Date.now() + ms;

  return () => Date.now() < end;
};

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

// Background chaos: abort one random shard (or all) every few seconds while the checks run.
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
