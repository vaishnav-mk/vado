// The catalog of databases. A database's shard count is fixed when it is created: by an explicit
// count, or by the SHARD_EPOCHS entry in force at creation (a new epoch
// sizes new databases and never moves an existing one).
import { DurableObject } from "cloudflare:workers";
import { epochAt, parseEpochs } from "../protocol/slots.js";
import { SHARD_CLASSES } from "../constants.js";
import { HINTS } from "../replication/regions.js";

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
    // Added later: how many shard classes the shards rotate over; NULL = 1 (every shard in ValkeyShard).
    if (!cols.includes("classes")) this.#sql.exec(`ALTER TABLE dbs ADD COLUMN classes INTEGER`);
    // Added later: the database's own password, as "salt:sha256(salt + password)" in hex; NULL = VALKEY_PASSWORD.
    if (!cols.includes("secret")) this.#sql.exec(`ALTER TABLE dbs ADD COLUMN secret TEXT`);
    // Added later: when the database was dropped (its name is never reused); NULL = it wasn't.
    if (!cols.includes("dropped")) this.#sql.exec(`ALTER TABLE dbs ADD COLUMN dropped INTEGER`);
  }

  /** The database's record, created on first use. `shards`, `regions` and `replicas` apply only to a new database. */
  get(name, shards, regions, replicas, classes = SHARD_CLASSES, secret = null) {
    if (!DB_NAME.test(name)) throw new Error(DB_NAME_RULE);
    const row = this.find(name);
    if (row?.dropped) throw new Error(`database ${name} was dropped`);
    if (row) return row;
    const created = Date.now();
    const count = shards ?? epochAt(this.#epochs, created).shards;
    if (!Number.isSafeInteger(count) || count < 1 || count > 16384) throw new Error("shards must be 1..16384");
    for (const list of [regions, replicas]) if (list !== undefined && (!Array.isArray(list) || !list.length || !list.every((r) => HINTS.has(r)))) throw new Error(`regions and replicas must be lists of ${[...HINTS].join(", ")}`);
    if (!Number.isSafeInteger(classes) || classes < 1 || classes > SHARD_CLASSES) throw new Error(`classes must be 1..${SHARD_CLASSES}`);
    const r = { name, created, shards: count, regions: regions ? JSON.stringify(regions) : null, replicas: replicas ? JSON.stringify(replicas) : null, classes, secret };
    this.#sql.exec(`INSERT INTO dbs (name, created, shards, regions, replicas, classes, secret) VALUES (?, ?, ?, ?, ?, ?, ?)`, r.name, r.created, r.shards, r.regions, r.replicas, r.classes, r.secret);
    return record(r);
  }

  /** The database's record, or null: never creates one. */
  find(name) {
    const row = this.#sql.exec(`SELECT name, created, shards, regions, replicas, classes, secret, dropped FROM dbs WHERE name = ?`, name).toArray()[0];
    return row ? record(row) : null;
  }

  /** Every database not dropped, without password hashes. */
  list() {
    return this.#sql.exec(`SELECT name, created, shards, regions, replicas, classes, secret IS NOT NULL AS password FROM dbs WHERE dropped IS NULL ORDER BY name`).toArray().map(record);
  }

  /** Marks the database dropped; its record stays, so the name (and its shards' names) is never reused. */
  drop(name) {
    this.#sql.exec(`UPDATE dbs SET dropped = ? WHERE name = ? AND dropped IS NULL`, Date.now(), name);
  }
}
