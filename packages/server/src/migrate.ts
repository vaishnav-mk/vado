import type { DurableMigrations } from "@durability/storage";
import { DOQB } from "workers-qb";

// Columns a table from before migrations lacks; CREATE TABLE IF NOT EXISTS skips a table that exists.
export interface Legacy {
  table: string;
  columns: readonly (readonly [name: string, type: string])[];
}

export function addMissingColumns(sql: Pick<SqlStorage, "exec">, { table, columns }: Legacy): void {
  const have = new Set(
    sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .map((c) => c.name),
  );

  // No table yet: the migration creates it whole.
  if (!have.size) return;

  for (const [name, type] of columns) if (!have.has(name)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}

export function migrate(
  storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
  migrations: DurableMigrations,
  legacy?: Legacy,
): void {
  storage.transactionSync(() => {
    if (legacy) addMissingColumns(storage.sql, legacy);
    new DOQB(storage.sql)
      .migrations({
        migrations: migrations.map((m) => ({ name: m.name, sql: m.up })),
        tableName: "durability_migrations",
      })
      .apply();
  });
}
