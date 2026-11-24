import * as v from "valibot";
import { catalogStub, database, forget, lookup, parseFlavour } from "../catalog/databases";
import { configureReplicas, replicaStub, shardStub } from "../catalog/placement";
import { shardSnapshots } from "../admin/snapshot";
import { HINT_NAMES, isHint, WORLD } from "../catalog/regions";
import { UNSUPPORTED } from "../router/command-sets";
import { hashSecret } from "../router/secrets";
import type { Hint } from "../catalog/types";
import { noop } from "../shared";
import type { Test } from "./types";
import { allShards, dbName, open } from "./util";

function hints(s: string): Hint[] {
  const out = s === "world" ? WORLD : s.split(",");

  if (!out.every(isHint)) throw new Error(`regions and replicas must be lists of ${HINT_NAMES}`);

  return out;
}

const list = (s: string | null) => (s ? hints(s) : undefined);

// via=shard goes past the router, which refuses these.
const RAW_REFUSED = new Set(["config", ...UNSUPPORTED]);

const Commands = v.array(v.array(v.pipe(v.union([v.string(), v.number()]), v.transform(String))));

// password=new's password is returned only here; AUTH over TCP or WebSocket then takes only it, not VALKEY_PASSWORD.
const db: Test = async (env, q) => {
  const password =
    q.get("password") === "new"
      ? btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
      : null;

  const secret = password && (await hashSecret(password));
  const flavour = q.get("flavour");

  const { secret: stored, ...record } = await database(
    env,
    dbName(q),
    q.get("shards") ? Number(q.get("shards")) : undefined,
    list(q.get("regions")),
    list(q.get("replicas")),
    q.get("classes") ? Number(q.get("classes")) : undefined,
    secret,
    flavour === null ? undefined : parseFlavour(env, flavour),
  );

  if (password && stored !== secret) throw new Error("the database already exists, so it keeps the password it has");

  if (record.replicas) await configureReplicas(env, record);

  const out = { db: { ...record, password: !!stored } };

  return password ? { ...out, password } : out;
};

const drop: Test = async (env, q) => {
  const db = await lookup(env, dbName(q));

  if (!db) throw new Error("no such database");
  // Marked first, so the name is never reused even if a shard's drop fails.
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

const abort: Test = async (env, q) => {
  const db = await database(env, dbName(q));
  const which = q.get("shard") ?? "all";
  const idx = which === "all" ? Array.from({ length: db.shards }, (_, i) => i) : [Number(which)];
  const replica = q.get("replica");

  if (replica !== null && !isHint(replica)) throw new Error(`replica must be one of ${HINT_NAMES}`);
  await Promise.all(
    // On a native Redis shard, reason=kill also destroys the container and reason=container only that.
    idx.map((i) =>
      (replica ? replicaStub(env, db, i, replica) : shardStub(env, db, i))
        .abort(q.get("reason") ?? undefined)
        .catch(noop),
    ),
  );

  return replica ? { aborted: idx, replica } : { aborted: idx };
};

// Replication only: reads stay where the record says.
const replicate: Test = async (env, q) => {
  const asked = q.get("regions") ?? "";
  const regions = asked === "none" ? [] : hints(asked);
  await configureReplicas(env, { ...(await database(env, dbName(q))), replicas: regions });

  return { regions };
};

const shards: Test = async (env, q) => {
  const db = await database(env, dbName(q));

  return { db, shards: await shardSnapshots(env, db) };
};

const stats: Test = async (env, q) => ({
  shards: await allShards(env, dbName(q), async (stub) => {
    const { files, ...rest } = await stub.stats();

    return { ...rest, files: files.map((f) => `${f.path}:${f.size}/${f.rows}`) };
  }),
});

const send: Test = async (env, q) => {
  const hint = q.get("region") ?? "";

  if (!isHint(hint)) throw new Error(`region must be one of ${HINT_NAMES}`);
  const params = Object.fromEntries(q);
  delete params.region;
  delete params.sender;
  const name = q.get("sender") ? `${hint}/${q.get("sender")}` : hint;

  return { region: hint, ...(await env.SENDER.getByName(name, { locationHint: hint }).run(params)) };
};

const run: Test = async (env, q, req) => {
  if (!req) throw new Error("run takes the commands as a POST body");
  const cmds = v.parse(Commands, await req.json());
  const refused = q.get("via") === "shard" && cmds.find(([name = ""]) => RAW_REFUSED.has(name.toLowerCase()));

  if (refused) throw new Error(`via=shard doesn't run ${refused[0]}`);
  const c = await open(env, q);

  try {
    return { replies: await c.call(...cmds) };
  } finally {
    c.close();
  }
};

export const catalogTests = { db, drop, abort, replicate, shards, stats, send, run };
