// The catalog of databases. A database's shard count is fixed when it is created: by an explicit
// count, or by the SHARD_EPOCHS entry in force at creation (a new epoch
// sizes new databases and never moves an existing one).
import { DurableObject } from "cloudflare:workers";
import { epochAt, parseEpochs } from "./slots.js";

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export class Catalog extends DurableObject {
  #sql;
  #epochs;

  constructor(ctx, env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#epochs = parseEpochs(env.SHARD_EPOCHS);
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS dbs (name TEXT PRIMARY KEY, created INTEGER NOT NULL, shards INTEGER NOT NULL)`);
  }

  /** The database's record, created on first use. `shards` applies only to a new database. */
  get(name, shards) {
    if (!NAME.test(name)) throw new Error(`invalid database name ${JSON.stringify(name)}`);
    const row = this.#sql.exec(`SELECT name, created, shards FROM dbs WHERE name = ?`, name).toArray()[0];
    if (row) return row;
    const created = Date.now();
    const count = shards ?? epochAt(this.#epochs, created).shards;
    if (!Number.isSafeInteger(count) || count < 1 || count > 16384) throw new Error("shards must be 1..16384");
    this.#sql.exec(`INSERT INTO dbs (name, created, shards) VALUES (?, ?, ?)`, name, created, count);
    return { name, created, shards: count };
  }

  list() {
    return this.#sql.exec(`SELECT name, created, shards FROM dbs ORDER BY name`).toArray();
  }
}
