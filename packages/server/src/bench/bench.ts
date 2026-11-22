// Tests and probes that run inside Cloudflare, for BENCH_TOKEN holders: GET /<test>?db=<name>&via=router|shard&...
import { sameSecret } from "../router/secrets";
import { catalogTests } from "./catalog-tests";
import { dataTests } from "./data-tests";
import { loadTests } from "./load-tests";
import { shardProbes } from "./shard-probes";
import type { Test } from "./types";

const tests = new Map<string, Test>(
  Object.entries({ ...catalogTests, ...shardProbes, ...dataTests, ...loadTests } satisfies Record<string, Test>),
);

export const runTest = (name: string, env: Env, q: URLSearchParams, req?: Request): Promise<object> => {
  const test = tests.get(name);

  if (!test) throw new Error(`no test named ${name}`);

  return test(env, q, req);
};

export async function bench(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  // Unset BENCH_TOKEN means no bench API, not a token of "undefined".
  if (!env.BENCH_TOKEN || !sameSecret(req.headers.get("authorization") ?? "", `Bearer ${env.BENCH_TOKEN}`))
    return new Response("unauthorized", { status: 401 });
  const name = url.pathname.slice(1);

  if (!tests.has(name)) return new Response(`tests: ${[...tests.keys()].join(", ")}`, { status: 404 });
  const q = url.searchParams;
  q.set("via", q.get("via") ?? "router");
  q.set("db", q.get("db") ?? "default");

  try {
    return Response.json({
      test: name,
      via: q.get("via"),
      db: q.get("db"),
      colo: req.cf?.colo,
      ...(await runTest(name, env, q, req)),
    });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));

    return Response.json({ test: name, error: error.message, stack: error.stack }, { status: 500 });
  }
}
