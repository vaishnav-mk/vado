import type { DurableMigrations } from "@durability/storage";

export const shardMigrations = [
  {
    name: "shard_0001_tables",
    up: `CREATE TABLE IF NOT EXISTS restarts (deployed INTEGER NOT NULL, at INTEGER NOT NULL, report TEXT);
CREATE TABLE IF NOT EXISTS commit_probe (k INTEGER PRIMARY KEY, v INTEGER);`,
    // Reverting would lose the restart history lastUpgrade reports.
    down: "SELECT 1;",
  },
] satisfies DurableMigrations;

// Applied only by drop(): the table's existence is the tombstone, so no live shard may create it.
export const tombstoneMigrations = [
  {
    name: "tombstone_0001_dropped",
    up: "CREATE TABLE IF NOT EXISTS dropped (at INTEGER NOT NULL);",
    // A dropped shard stays dropped.
    down: "SELECT 1;",
  },
] satisfies DurableMigrations;
