// Databases and shards: create, drop, reset, look at, and run commands or tests on them.
import * as v from "valibot";
import { catalogStub, database, forget, lookup } from "../catalog/databases";
import { configureReplicas, replicaStub, shardStub } from "../catalog/placement";
import { shardSnapshots } from "../admin/snapshot";
import { HINTS, isHint, WORLD } from "../replication/regions";
import { hashSecret } from "../router/secrets";
import type { Flavour, Hint } from "../catalog/types";
import { FLAVOURS } from "../shard/servers";
import type { Test } from "./types";
import { allShards, open } from "./util";

/** world, or a,b,c: location hints. */
function hints(v: string): Hint[] {
  const out = v === "world" ? WORLD : v.split(",");

  if (!out.every(isHint)) throw new Error(`regions and replicas must be lists of ${[...HINTS].join(", ")}`);

  return out;
}

const list = (v: string | null) => (v ? hints(v) : undefined);

function flavour(v: string | null): Flavour | undefined {
  if (v === null) return undefined;
  const known = FLAVOURS.find((f) => f === v);

  if (!known) throw new Error(`this build runs ${FLAVOURS.join(" or ")}, not ${v}`);

  return known;
}

const Commands = v.array(v.array(v.pipe(v.union([v.string(), v.number()]), v.transform(String))));

// regions=world spreads a new database's shards over WORLD; regions=a,b,c over those hints. replicas=world (or
// a,b,c) keeps a read replica of every shard in each. password=new gives a new database its own password, returned
// only here; AUTH over TCP or WebSocket then takes only that one (VALKEY_PASSWORD still works through a binding).
const db: Test = async (env, q) => {
  const password =
    q.get("password") === "new"
      ? btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
      : null;

  const secret = password && (await hashSecret(password));

  const { secret: stored, ...record } = await database(
    env,
    q.get("db") ?? "default",
    q.get("shards") ? Number(q.get("shards")) : undefined,
    list(q.get("regions")),
    list(q.get("replicas")),
    q.get("classes") ? Number(q.get("classes")) : undefined,
    secret,
    flavour(q.get("flavour")),
  );

  if (password && stored !== secret) throw new Error("the database already exists, so it keeps the password it has");

  if (record.replicas) await configureReplicas(env, record);

  const out = { db: { ...record, password: !!stored } };

  return password ? { ...out, password } : out;
};

// The catalog marks it dropped (the name is never reused), then every shard deletes its storage, keeping only a
// tombstone that refuses to boot, and retires its replicas.
const drop: Test = async (env, q) => {
  const db = await lookup(env, q.get("db") ?? "default");

  if (!db) throw new Error("no such database");
  await catalogStub(env).drop(db.name);
  forget(db.name);
  const ids = [...Array.from({ length: db.shards }, (_, i) => i), "pubsub" as const];

  const failed = await Promise.all(
    ids.map((i) =>
      shardStub(env, db, i)
        .drop()
        .then(
          () => [],
          (e: Error) => [[i, e.message]],
        ),
    ),
  );

  return { dropped: db.name, shards: db.shards, failed: failed.flat() };
};

// Chaos hook: hard-reset one shard (shard=<i>) or all of them, as a crash or deploy would; replica=<region> resets
// that region's replica of each instead.
const abort: Test = async (env, q) => {
  const db = await database(env, q.get("db") ?? "default");
  const which = q.get("shard") ?? "all";
  const idx = which === "all" ? Array.from({ length: db.shards }, (_, i) => i) : [Number(which)];
  const replica = q.get("replica");

  if (replica !== null && !isHint(replica)) throw new Error(`replica must be one of ${[...HINTS].join(", ")}`);
  await Promise.all(
    idx.map((i) => (replica ? replicaStub(env, db, i, replica) : shardStub(env, db, i)).abort().catch(() => {})),
  );

  return replica ? { aborted: idx, replica } : { aborted: idx };
};

// A/B on one primary: point its shards' replication at `regions` (none | world | a,b), leaving reads alone.
const replicate: Test = async (env, q) => {
  const db = await database(env, q.get("db") ?? "default"),
    v = q.get("regions") ?? "";

  const regions = v === "none" ? [] : hints(v);
  await Promise.all(Array.from({ length: db.shards }, (_, i) => shardStub(env, db, i).replicate(regions)));

  return { regions };
};

// Every shard's stats with Valkey's own INFO counters, and its ready replicas'.
const shards: Test = async (env, q) => {
  const db = await database(env, q.get("db") ?? "default");

  return { db, shards: await shardSnapshots(env, db) };
};

const stats: Test = async (env, q) => ({
  shards: await allShards(env, q.get("db") ?? "default", async (stub) => {
    const { files, ...rest } = await stub.stats();

    return { ...rest, files: files.map((f) => `${f.path}:${f.size}/${f.rows}`) };
  }),
});

// Runs a test (default throughput) from a Sender in `region`, so its traffic enters Cloudflare there. sender=<k>
// picks one of several Senders in the region, so load can come from many isolates.
const send: Test = async (env, q) => {
  const hint = q.get("region") ?? "";

  if (!isHint(hint)) throw new Error(`region must be one of ${[...HINTS].join(", ")}`);
  const params = Object.fromEntries(q);
  delete params.region;
  delete params.sender;
  const name = q.get("sender") ? `${hint}/${q.get("sender")}` : hint;

  return { region: hint, ...(await env.SENDER.getByName(name, { locationHint: hint }).run(params)) };
};

// Arbitrary commands: POST [["SET","k","v"],["GET","k"]].
const run: Test = async (env, q, req) => {
  if (!req) throw new Error("run takes the commands as a POST body");
  const cmds = v.parse(Commands, await req.json());
  const c = await open(env, q);
  const replies = await c.call(...cmds);
  c.close();

  return { replies };
};

export const catalogTests = { db, drop, abort, replicate, shards, stats, send, run };
