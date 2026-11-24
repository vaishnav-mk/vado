import { DurableObject } from "cloudflare:workers";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { SLOTS } from "../protocol/slots";
import { HINT_NAMES, HINTS } from "./regions";
import { SHARD_CLASSES } from "../wasm-shard/config";
import { epochAt, parseEpochs } from "./epochs";
import { migrate } from "../migrate";
import { addMissingColumns } from "./legacy";
import { catalogMigrations } from "./migrations";
import { isFlavour, isNative } from "./flavours";
import { DB_NAME, DB_NAME_RULE } from "./names";
import { dbs } from "./schema";
import type { DatabaseRecord, DatabaseSummary, Epoch, Flavour, Hint } from "./types";

const record = <R extends { flavour: string | null }>(row: R): Omit<R, "flavour"> & { flavour: Flavour } => ({
  ...row,
  flavour: isFlavour(row.flavour) ? row.flavour : "valkey",
});

const hintList = (list: Hint[] | undefined) =>
  list === undefined || (Array.isArray(list) && list.length > 0 && list.every((r) => HINTS.has(r)));

export class Catalog extends DurableObject<Env> {
  #epochs: Epoch[] = parseEpochs(this.env.SHARD_EPOCHS);
  #db = drizzle(this.ctx.storage);
  // The hottest statement: the Watcher asks once a second per watched database.
  #find = this.#db
    .select()
    .from(dbs)
    .where(eq(dbs.name, sql.placeholder("name")))
    .limit(1)
    .prepare();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage, catalogMigrations, addMissingColumns);
  }

  // Every setting applies only to a new database.
  get(
    name: string,
    shards?: number,
    regions?: Hint[],
    replicas?: Hint[],
    classes: number = SHARD_CLASSES,
    secret: string | null = null,
    flavour: Flavour = "valkey",
  ): DatabaseRecord {
    if (!DB_NAME.test(name)) throw new Error(DB_NAME_RULE);
    const row = this.find(name);

    if (row?.dropped) throw new Error(`database ${name} was dropped`);

    if (row) return row;
    const created = Date.now();
    const count = shards ?? epochAt(this.#epochs, created).shards;

    if (!Number.isSafeInteger(count) || count < 1 || count > SLOTS) throw new Error("shards must be 1..16384");

    if (!hintList(regions) || !hintList(replicas))
      throw new Error(`regions and replicas must be lists of ${HINT_NAMES}`);

    if (!Number.isSafeInteger(classes) || classes < 1 || classes > SHARD_CLASSES)
      throw new Error(`classes must be 1..${SHARD_CLASSES}`);

    // The Worker checks the flavour against its build: after a deploy this object can run the old one for minutes.
    if (!isFlavour(flavour)) throw new Error("unknown flavour");

    if (replicas && isNative(flavour)) throw new Error("databases in containers have no read replicas yet");

    const fresh = {
      name,
      created,
      shards: count,
      regions: regions ?? null,
      replicas: replicas ?? null,
      classes,
      secret,
      flavour: flavour === "valkey" ? null : flavour,
    };

    this.#db.insert(dbs).values(fresh).run();

    return record(fresh);
  }

  find(name: string): DatabaseRecord | null {
    const row = this.#find.get({ name });

    return row ? record(row) : null;
  }

  list(): DatabaseSummary[] {
    return this.#db
      .select({
        name: dbs.name,
        created: dbs.created,
        shards: dbs.shards,
        regions: dbs.regions,
        replicas: dbs.replicas,
        classes: dbs.classes,
        flavour: dbs.flavour,
        password: sql<number>`${dbs.secret} IS NOT NULL`,
      })
      .from(dbs)
      .where(isNull(dbs.dropped))
      .orderBy(asc(dbs.name))
      .all()
      .map(record);
  }

  // The record stays, so the name and its shards' names are never reused.
  drop(name: string): void {
    this.#db
      .update(dbs)
      .set({ dropped: Date.now() })
      .where(and(eq(dbs.name, name), isNull(dbs.dropped)))
      .run();
  }
}
