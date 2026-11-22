import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A dropped shard's tombstone: the table's existence is the mark (older code checks for it). */
export const dropped = sqliteTable("dropped", { at: integer("at").notNull() });

/** Restarts onto newer code: `deployed` is the code it restarted for, `report` what the restart took (JSON). */
export const restarts = sqliteTable("restarts", {
  deployed: integer("deployed").notNull(),
  at: integer("at").notNull(),
  report: text("report"),
});

export const commitProbe = sqliteTable("commit_probe", { k: integer("k").primaryKey(), v: integer("v") });
