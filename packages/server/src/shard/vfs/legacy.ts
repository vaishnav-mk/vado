// Brings tables from before migrations up to vfs_0001_tables, whose CREATE IF NOT EXISTS skips them.
export function addMissingColumns(sql: Pick<SqlStorage, "exec">): void {
  const columns = sql.exec<{ name: string }>("PRAGMA table_info(vfs_node)").toArray();

  // No columns: no table yet, and the migration creates it whole.
  if (columns.length && !columns.some((c) => c.name === "chunks"))
    sql.exec("ALTER TABLE vfs_node ADD COLUMN chunks TEXT");
}
