// The dashboard's API: an RPC entrypoint ("Admin") that only Workers bound to it can call. Live numbers come
// from /live (a Watcher per database, src/admin/watcher.js); this is the rest: the database list, creating
// one, running a command, restarting a shard, test traffic, and signing in. It never returns a password
// hash or a client's address. Signing in is by BENCH_TOKEN: session() trades it for a signed, expiring
// session string, so the dashboard never stores the token, and authorized() checks one.
import { WorkerEntrypoint } from "cloudflare:workers";
import { configureReplicas, current, database, replicaRegion, shardStub } from "../catalog/databases.js";
import { DB_NAME, DB_NAME_RULE } from "../catalog/catalog.js";
import { RespClient } from "../client/resp-client.js";
import { keyIndexes } from "../protocol/commands.js";
import { shardOfSlot, slotOf } from "../protocol/slots.js";
import { commands } from "../router/serve.js";
import { sameSecret } from "../router/secrets.js";
import { coloOf, HINTS, REGION_NAMES, WORLD } from "../replication/regions.js";
import { dbView } from "./views.js";

const enc = new TextEncoder();
const SHARD_COUNTS = new Set([1, 4, 16, 64]);
const SESSION_MS = 7 * 24 * 3600_000;
const WAIT_MS = 3_000; // how long a write from the dashboard waits to hear from its replicas
// One-shot calls can't use these: they need a connection that stays open.
const NEEDS_A_CONNECTION = new Set(["subscribe", "psubscribe", "ssubscribe", "monitor", "multi", "watch", "reset", "quit"]);
// Not from a button: KEYS returns every key at once (SCAN pages through them), and a flush wipes the database.
const REFUSED = { keys: "KEYS returns every key at once; use SCAN", flushall: "FLUSHALL wipes the database; run it from a client", flushdb: "FLUSHDB wipes the database; run it from a client" };

/** Whether `session` is a live session string from session(): also how /live tells signed-in watchers apart. */
export async function signedIn(env, session) {
  if (!env.BENCH_TOKEN || typeof session !== "string") return false;
  const [until, mac] = session.split(".");
  return Number(until) > Date.now() && sameSecret(mac ?? "", await hmac(env.BENCH_TOKEN, `dashboard:${until}`));
}

let myColo = null; // this isolate's colo, once known
const colo = async () => (myColo ??= await coloOf().catch(() => null));

async function hmac(key, text) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Admin extends WorkerEntrypoint {
  /** Every database there is (not internal ones, not dropped ones). */
  async databases() {
    return (await this.env.CATALOG.getByName("catalog").list()).filter((d) => !d.name.startsWith("__")).map(dbView);
  }

  /** Database `name`, or null if there is none. */
  async database(name) {
    const db = await this.#find(name);
    return db && dbView(db);
  }

  /** The regions a database can use, by location hint. */
  regions() {
    return Object.fromEntries(WORLD.map((r) => [r, REGION_NAMES[r]]));
  }

  /** A new database: `shards` of 1, 4, 16 or 64, placed in one region or spread over the world (`place`
   *  "world"), with read replicas in every region or none. Refuses a name that is taken. */
  async create({ name, shards, place, replicas }) {
    if (typeof name !== "string" || !DB_NAME.test(name)) throw new Error(DB_NAME_RULE);
    if (!SHARD_COUNTS.has(shards)) throw new Error("shards is 1, 4, 16 or 64");
    if (place !== "world" && !HINTS.has(place)) throw new Error("place is world or a region");
    if (await current(this.env, name)) throw new Error(`${name} already exists`);
    const db = await database(this.env, name, shards, place === "world" ? WORLD : [place], replicas ? WORLD : undefined);
    if (db.replicas) await configureReplicas(this.env, db);
    await this.#watcher(name).note("action", `Created ${name}: ${shards} shard${shards === 1 ? "" : "s"}, ${place === "world" ? "spread around the world" : `in ${REGION_NAMES[place] ?? place}`}${replicas ? ", with read replicas in every region" : ""}`);
    return dbView(db);
  }

  /** Hard-resets shard `i` of database `name`, as a crash or deploy would. Saved data stays. */
  async restart(name, i) {
    const db = await this.#find(name, true);
    if (!Number.isInteger(i) || i < 0 || i >= db.shards) throw new Error(`shard is 0 to ${db.shards - 1}`);
    await this.#watcher(name).restarting(i);
    await shardStub(this.env, db, i).abort("restarted from the dashboard").catch(() => {});
  }

  /** Starts test traffic on database `name` (level light, medium or heavy; from a region, or everywhere). */
  async startTest(name, level, from) {
    await this.#find(name, true);
    return await this.#watcher(name).startTest(level, from);
  }

  async stopTest(name) {
    return await this.#watcher(name).stopTest();
  }

  /** Runs one command on database `name` and says where it went: the key's slot and shard, the colo the
   *  router ran in, the replica region a read is served from, and for a write on a replicated database,
   *  how many replicas had it within WAIT_MS. */
  async command(name, argv) {
    if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== "string")) throw new Error("expected the command as a list of strings");
    const cmd = argv[0].toLowerCase();
    if (NEEDS_A_CONNECTION.has(cmd)) throw new Error(`${argv[0].toUpperCase()} needs a client that keeps its connection open, such as valkey-cli`);
    if (Object.hasOwn(REFUSED, cmd)) throw new Error(REFUSED[cmd]);
    const db = await this.#find(name, true);
    const table = await commands(this.env, db.flavour), entry = table.get(cmd);
    const idx = keyIndexes(table, cmd, argv.map((a) => enc.encode(a)));
    const key = idx?.length ? argv[idx[0]] : null, slot = key === null ? null : slotOf(enc.encode(key));
    const write = !!entry?.flags.has("write"), read = !!entry?.flags.has("readonly");
    const [c, here] = await Promise.all([RespClient.open(this.env, name, 15_000), colo()]);
    try {
      // The connection is new, so its router hasn't reached this key's shard (or replica) yet. Warm that path
      // with a command that changes nothing and goes where this one will, so the time shown is the command's,
      // not a connection setup's: a read of the key, or for a write that a read would send elsewhere (to a
      // replica), a delete of a dashboard-only key in the same slot (`{key}` is a hash tag for key's slot).
      if (key !== null) await c.call(write && db.replicas && !/[{}]/.test(key) ? ["DEL", `dashboard:warm:{${key}}`] : ["EXISTS", key]);
      const t0 = performance.now();
      const [reply] = await c.call(argv);
      const ms = performance.now() - t0;
      let replication = null;
      if (write && db.replicas && !reply?.err) {
        const t1 = performance.now();
        const [acked] = await c.call(["WAIT", String(db.replicas.length), String(WAIT_MS)]);
        replication = { acked, of: db.replicas.length, ms: performance.now() - t1 };
      }
      return { reply, ms, write, read, key, slot, shard: slot === null ? null : shardOfSlot(slot, db.shards), colo: here, replica: read ? replicaRegion(db, here) : null, replication };
    } finally { c.close(); }
  }

  /** A session string for `token` if it is BENCH_TOKEN, else null. */
  async session(token) {
    if (!this.env.BENCH_TOKEN || typeof token !== "string" || !sameSecret(token, this.env.BENCH_TOKEN)) return null;
    const until = Date.now() + SESSION_MS;
    return `${until}.${await hmac(this.env.BENCH_TOKEN, `dashboard:${until}`)}`;
  }

  /** Whether a session string from session() is still good. */
  async authorized(session) {
    return await signedIn(this.env, session);
  }

  async #find(name, required = false) {
    if (typeof name !== "string" || !DB_NAME.test(name)) throw new Error(DB_NAME_RULE);
    const db = await current(this.env, name);
    if (db && !db.dropped) return db;
    if (required) throw new Error(`no database named ${name}`);
    return null;
  }

  #watcher(name) {
    return this.env.WATCHER.getByName(name);
  }
}
