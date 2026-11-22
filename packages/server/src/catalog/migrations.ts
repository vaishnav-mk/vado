import type { DurableMigrations } from "@durability/storage";

export const catalogMigrations = [
  {
    name: "catalog_0001_dbs",
    up: `CREATE TABLE IF NOT EXISTS dbs (name TEXT PRIMARY KEY, created INTEGER NOT NULL, shards INTEGER NOT NULL, regions TEXT, replicas TEXT, classes INTEGER, secret TEXT, dropped INTEGER, flavour TEXT);`,
    // Reverting would lose every database's record, and with it the rule that a dropped name is never reused.
    down: "SELECT 1;",
  },
] satisfies DurableMigrations;
