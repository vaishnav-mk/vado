// Brings a dbs table from before migrations up to catalog_0001_dbs, whose CREATE IF NOT EXISTS skips it.
const ADDED = [
  ["regions", "TEXT"],
  ["replicas", "TEXT"],
  ["classes", "INTEGER"],
  ["secret", "TEXT"],
  ["dropped", "INTEGER"],
  ["flavour", "TEXT"],
] as const;

/** The part of SqlStorage this needs. */
export interface ColumnsSql {
  exec(query: string): { toArray(): { name: SqlStorageValue }[] };
}

export function addMissingColumns(sql: ColumnsSql): void {
  const columns = new Set(
    sql
      .exec("PRAGMA table_info(dbs)")
      .toArray()
      .map((c) => c.name),
  );

  // No columns: no table yet, and the migration creates it whole.
  if (!columns.size) return;

  for (const [name, type] of ADDED) if (!columns.has(name)) sql.exec(`ALTER TABLE dbs ADD COLUMN ${name} ${type}`);
}
