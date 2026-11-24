import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Hint } from "../../catalog/types";

export const replTargets = sqliteTable("repl_targets", {
  region: text("region").$type<Hint>().primaryKey(),
});

export const replAsleep = sqliteTable("repl_asleep", {
  since: integer("since").notNull(),
});
