import { sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "../migrate";
import { tombstoneMigrations } from "./migrations";
import { dropped } from "./schema";

export const isDropped = (storage: Pick<SqlStorage, "exec">): boolean =>
  storage.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dropped'").toArray().length > 0;

export const droppable = (name: string): boolean =>
  name !== "dropped" && !name.startsWith("_cf_") && !name.startsWith("sqlite_");

// The tombstone goes first: a reset partway still leaves a dropped shard, never an empty live one.
export async function bury(storage: DurableObjectStorage, db: DrizzleSqliteDODatabase): Promise<void> {
  migrate(storage, tombstoneMigrations);
  db.insert(dropped).values({ at: Date.now() }).run();
  await storage.sync();

  const tables = db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`);

  for (const { name } of tables) if (droppable(name)) db.run(sql.raw(`DROP TABLE "${name}"`));
  await storage.sync();
}
