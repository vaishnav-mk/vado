import type { DurableMigrations } from "@durability/storage";
import { DOQB } from "workers-qb";

// `upgrade` adds columns that tables from before migrations lack, since CREATE TABLE IF NOT EXISTS skips them.
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
