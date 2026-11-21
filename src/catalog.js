// The catalog of databases. A database's shard count is fixed when it is created: by an explicit
// count, or by the SHARD_EPOCHS entry in force at creation (a new epoch
// sizes new databases and never moves an existing one).
import { DurableObject } from "cloudflare:workers";
import { epochAt, parseEpochs } from "./slots.js";

/** Durable Object location hints. A database may spread its shards over several (`regions`). */
export const HINTS = new Set(["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"]);
/** One shard per region in turn, for a database spread around the world. */
export const WORLD = ["wnam", "enam", "sam", "weur", "eeur", "me", "afr", "apac", "oc"];

/** Database names. They become part of shard object names, so the catalog is the one place that defines them. */
export const DB_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const DB_NAME_RULE = "database names are 1-63 characters of a-z 0-9 _ -, starting with a letter or digit";

const record = ({ regions, replicas, ...r }) => ({ ...r, regions: regions ? JSON.parse(regions) : null, replicas: replicas ? JSON.parse(replicas) : null });

export class Catalog extends DurableObject {
  #sql;
  #epochs;

  constructor(ctx, env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#epochs = parseEpochs(env.SHARD_EPOCHS);
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS dbs (name TEXT PRIMARY KEY, created INTEGER NOT NULL, shards INTEGER NOT NULL)`);
    // Added later: where each shard is placed (JSON list of hints, shard i -> regions[i % n]); NULL = LOCATION_HINT.
    const cols = this.#sql.exec(`PRAGMA table_info(dbs)`).toArray().map((c) => c.name);
    if (!cols.includes("regions")) this.#sql.exec(`ALTER TABLE dbs ADD COLUMN regions TEXT`);
    // Added later: regions that keep a read replica of every shard (JSON list of hints); NULL = none.
    if (!cols.includes("replicas")) this.#sql.exec(`ALTER TABLE dbs ADD COLUMN replicas TEXT`);
  }

  /** The database's record, created on first use. `shards`, `regions` and `replicas` apply only to a new database. */
  get(name, shards, regions, replicas) {
    if (!DB_NAME.test(name)) throw new Error(DB_NAME_RULE);
    const row = this.#sql.exec(`SELECT name, created, shards, regions, replicas FROM dbs WHERE name = ?`, name).toArray()[0];
    if (row) return record(row);
    const created = Date.now();
    const count = shards ?? epochAt(this.#epochs, created).shards;
    if (!Number.isSafeInteger(count) || count < 1 || count > 16384) throw new Error("shards must be 1..16384");
    for (const list of [regions, replicas]) if (list !== undefined && (!Array.isArray(list) || !list.length || !list.every((r) => HINTS.has(r)))) throw new Error(`regions and replicas must be lists of ${[...HINTS].join(", ")}`);
    const r = { name, created, shards: count, regions: regions ? JSON.stringify(regions) : null, replicas: replicas ? JSON.stringify(replicas) : null };
    this.#sql.exec(`INSERT INTO dbs (name, created, shards, regions, replicas) VALUES (?, ?, ?, ?, ?)`, r.name, r.created, r.shards, r.regions, r.replicas);
    return record(r);
  }

  list() {
    return this.#sql.exec(`SELECT name, created, shards, regions, replicas FROM dbs ORDER BY name`).toArray().map(record);
  }
}
