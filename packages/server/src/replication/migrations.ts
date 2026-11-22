import type { DurableMigrations } from "@durability/storage";

// Tables from before migrations already have these columns, so CREATE IF NOT EXISTS is all an old shard needs.
export const replicationMigrations = [
  {
    name: "repl_0001_tables",
    up: `CREATE TABLE IF NOT EXISTS repl_targets (region TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS repl_asleep (since INTEGER NOT NULL);`,
    // Reverting would forget where a primary keeps its replicas.
    down: "SELECT 1;",
  },
] satisfies DurableMigrations;
