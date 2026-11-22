// What the dashboard does besides watching: the database list, creating one, running a command, restarting a shard
// and test traffic. Its server functions call this in the same Worker, check who is signed in first, and parse
// every input's form, so this checks only the rules. It never returns a password hash or a client's address.
import { catalogStub, current, database } from "../catalog/databases";
import { DB_NAME, DB_NAME_RULE } from "../catalog/names";
import { configureReplicas, shardStub } from "../catalog/placement";
import type { DatabaseRecord } from "../catalog/types";
import { isHint, REGION_NAMES, WORLD } from "../replication/regions";
import { FLAVOURS } from "../shard/servers";
import { command } from "./command";
import type { CommandResult, Database, TestLevel, TestView } from "./live-types";
import type { NewDatabase } from "./types";
import { dbView } from "./views";

const SHARD_COUNTS = new Set([1, 4, 16, 64]);

export class Admin {
  #env: Env;

  constructor(env: Env) {
    this.#env = env;
  }

  /** Every database there is, but dropped ones. */
  async databases(): Promise<Database[]> {
    return (await catalogStub(this.#env).list()).map(dbView);
  }

  /** Database `name`, or null if there is none. */
  async database(name: string): Promise<Database | null> {
    const db = await this.#find(name);

    return db && dbView(db);
  }

  /** The regions a database can use, by location hint. */
  regions(): Record<string, string> {
    return Object.fromEntries(WORLD.map((r) => [r, REGION_NAMES[r]]));
  }

  /** A new database of 1, 4, 16 or 64 shards, in one region or spread over the world (`place` "world"), with read
   *  replicas in every region or none. Refuses a name that is taken. */
  async create({ name, shards, place, replicas, flavour: asked = "valkey" }: NewDatabase): Promise<Database> {
    if (!DB_NAME.test(name)) throw new Error(DB_NAME_RULE);

    if (!SHARD_COUNTS.has(shards)) throw new Error("shards is 1, 4, 16 or 64");
    const hint = isHint(place) ? place : null;

    if (place !== "world" && !hint) throw new Error("place is world or a region");
    const flavour = FLAVOURS.find((f) => f === asked);

    if (!flavour) throw new Error(`this build runs ${FLAVOURS.join(" or ")}, not ${asked}`);

    if (await current(this.#env, name)) throw new Error(`${name} already exists`);
    const regions = hint ? [hint] : WORLD;
    const db = await database(this.#env, name, shards, regions, replicas ? WORLD : undefined, undefined, null, flavour);

    if (db.replicas) await configureReplicas(this.#env, db);
    const where = hint ? `in ${REGION_NAMES[hint] ?? hint}` : "spread around the world";
    await this.#env.WATCHER.getByName(name).note(
      "action",
      `Created ${name}, on ${flavour === "redis" ? "Redis" : "Valkey"}: ${shards} shard${shards === 1 ? "" : "s"}, ${where}${replicas ? ", with read replicas in every region" : ""}`,
    );

    return dbView(db);
  }

  /** Hard-resets shard `i` of database `name`, as a crash or deploy would. Saved data stays. */
  async restart(name: string, i: number): Promise<void> {
    const db = await this.#required(name);

    if (!Number.isInteger(i) || i < 0 || i >= db.shards) throw new Error(`shard is 0 to ${db.shards - 1}`);
    await this.#env.WATCHER.getByName(name).restarting(i);
    await shardStub(this.#env, db, i)
      .abort("restarted from the dashboard")
      .catch(() => {});
  }

  /** Starts test traffic on database `name` (from a region, or everywhere). */
  async startTest(name: string, level: TestLevel, from: string): Promise<TestView> {
    await this.#required(name);

    return await this.#env.WATCHER.getByName(name).startTest(level, from);
  }

  async stopTest(name: string): Promise<null> {
    if (!DB_NAME.test(name)) throw new Error(DB_NAME_RULE);

    return await this.#env.WATCHER.getByName(name).stopTest();
  }

  /** Runs one command on database `name`: its reply, and the key's slot and shard, the router's colo, the replica
   *  region a read is served from, and for a write on a replicated database, how many replicas had it. */
  async command(name: string, argv: string[]): Promise<CommandResult> {
    return await command(this.#env, await this.#required(name), argv);
  }

  async #find(name: string): Promise<DatabaseRecord | null> {
    if (!DB_NAME.test(name)) throw new Error(DB_NAME_RULE);
    const db = await current(this.#env, name);

    return db && !db.dropped ? db : null;
  }

  async #required(name: string): Promise<DatabaseRecord> {
    const db = await this.#find(name);

    if (!db) throw new Error(`no database named ${name}`);

    return db;
  }
}
