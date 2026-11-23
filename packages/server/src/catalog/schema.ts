import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Hint } from "./types";

export const dbs = sqliteTable("dbs", {
  name: text("name").primaryKey(),
  created: integer("created").notNull(),
  shards: integer("shards").notNull(),
  regions: text("regions", { mode: "json" }).$type<Hint[]>(),
  replicas: text("replicas", { mode: "json" }).$type<Hint[]>(),
  classes: integer("classes"),
  secret: text("secret"),
  dropped: integer("dropped"),
  flavour: text("flavour"),
});
