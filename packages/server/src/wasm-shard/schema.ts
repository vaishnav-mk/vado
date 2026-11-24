import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The table's existence is the tombstone (older code checks for it).
export const dropped = sqliteTable("dropped", { at: integer("at").notNull() });

export const restarts = sqliteTable("restarts", {
  deployed: integer("deployed").notNull(),
  at: integer("at").notNull(),
  report: text("report"),
});

export const commitProbe = sqliteTable("commit_probe", { k: integer("k").primaryKey(), v: integer("v") });
