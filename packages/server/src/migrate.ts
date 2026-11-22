// Every object's tables come from DurableMigrations lists, recorded in durability's migration history.
import type { DurableMigrations } from "@durability/storage";
import { DOQB } from "workers-qb";

/**
 * Runs the migrations this object hasn't, in one transaction. `upgrade` first adds columns that tables from before
 * migrations lack, since their CREATE TABLE IF NOT EXISTS skips a table that exists.
 */
export function migrate(
  storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
  migrations: DurableMigrations,
  upgrade?: (sql: SqlStorage) => void,
): void {
  storage.transactionSync(() => {
    upgrade?.(storage.sql);
    new DOQB(storage.sql)
      .migrations({
        migrations: migrations.map((m) => ({ name: m.name, sql: m.up })),
        tableName: "durability_migrations",
      })
      .apply();
  });
}
