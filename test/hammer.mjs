// PORT=6399 PW=... DB=hammer1 C=32 SECONDS=60 CHAOS=1 BASE=https://<worker> TOKEN=... [ONLY=incr,bank] [CHURN=200]
// [CMD_TIMEOUT=60000] node test/hammer.mjs. CHAOS=1 aborts shards via the bench API while the checks run.
import { bank, incr, lua } from "./hammer/counters.mjs";
import { bigValues, churn, expiry, pipelines, zset } from "./hammer/data.mjs";
import { CHAOS, chaos, chaosState, check, env, errors, results, SECONDS } from "./hammer/harness.mjs";
import { pubsub, queue } from "./hammer/messages.mjs";

const only = env.ONLY?.split(",");
const all = { incr, bank, queue, pubsub, lua, zset, bigValues, expiry, pipelines, churn };
const t0 = Date.now();
const chaosTask = CHAOS ? chaos() : null;

for (const [name, fn] of Object.entries(all)) {
  if (only && !only.includes(name)) continue;
  const limit = (SECONDS * 2 + 180) * 1000;
  let timer;

  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`stage timed out after ${limit / 1000}s`)), limit);
      }),
    ]);
  } catch (e) {
    check(name, false, { error: e.message });
  }

  clearTimeout(timer);
}

chaosState.stop = true;

await chaosTask;

// A shard reset must reach clients as LOST or a dropped connection, never as the runtime's reason for the reset.
const unexpected = Object.keys(errors).filter(
  (k) => !/shard connection lost|Connection is closed|ECONNRESET|max retries per request/.test(k),
);

check("failures are reported as LOST", unexpected.length === 0, { unexpected });

const failed = results.filter((r) => !r.passed);

console.log(
  JSON.stringify({
    summary: {
      checks: results.length,
      failed: failed.length,
      chaosAborts: chaosState.runs,
      seconds: Math.round((Date.now() - t0) / 1000),
      errors,
    },
  }),
);

process.exit(failed.length ? 1 : 0);
