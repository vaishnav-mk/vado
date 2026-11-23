import type { DurableMigrations } from "@durability/storage";

export const vfsMigrations = [
  {
    name: "vfs_0001_tables",
    up: `CREATE TABLE IF NOT EXISTS vfs_node (path TEXT PRIMARY KEY, is_dir INTEGER NOT NULL, size INTEGER NOT NULL, chunks TEXT);
CREATE TABLE IF NOT EXISTS vfs_chunk (path TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, seq)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS vfs_trash (key TEXT PRIMARY KEY);`,
    down: "SELECT 1;",
  },
] satisfies DurableMigrations;
