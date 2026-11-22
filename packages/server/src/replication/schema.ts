import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Hint } from "../catalog/types";

/** The regions a primary keeps replicas in. */
export const replTargets = sqliteTable("repl_targets", {
  region: text("region").$type<Hint>().primaryKey(),
});

/** A row while replication sleeps: a primary rebooted then must not copy every replica again. */
export const replAsleep = sqliteTable("repl_asleep", {
  since: integer("since").notNull(),
});
