import type { DurableMigrations } from "@durability/storage";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { catalogLegacy, catalogMigrations } from "../../src/catalog/migrations";
import { addMissingColumns } from "../../src/migrate";
import { fakeStorage } from "../wasm-shard/vfs/fake-storage";

// The catalog as code from before regions, replicas and the rest created it.
const OLD = [
  {
    name: "test_old_dbs",
    up: "CREATE TABLE dbs (name TEXT PRIMARY KEY, created INTEGER NOT NULL, shards INTEGER NOT NULL, regions TEXT)",
    down: "SELECT 1;",
  },
] satisfies DurableMigrations;

const columns = (db: DatabaseSync) =>
  db
    .prepare("PRAGMA table_info(dbs)")
    .all()
    .map((c) => `${String(c.name)} ${String(c.type)}`);

test("an old catalog gets every column it lacks, in order, and keeps its rows", () => {
  const old = fakeStorage();
  old.db.exec(OLD[0].up);
  old.db.exec("INSERT INTO dbs VALUES ('old', 1, 2, NULL)");
  addMissingColumns(old.sql, catalogLegacy);
  addMissingColumns(old.sql, catalogLegacy);

  const fresh = new DatabaseSync(":memory:");
  fresh.exec(catalogMigrations[0].up);
  expect(columns(old.db)).toEqual(columns(fresh));
  expect(old.db.prepare("SELECT name, shards, flavour FROM dbs").all()).toEqual([
    { name: "old", shards: 2, flavour: null },
  ]);
});

test("a new catalog is left to the migration", () => {
  const db = fakeStorage();
  addMissingColumns(db.sql, catalogLegacy);
  expect(columns(db.db)).toEqual([]);
});
