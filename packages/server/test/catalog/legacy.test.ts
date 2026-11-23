import type { DurableMigrations } from "@durability/storage";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { addMissingColumns } from "../../src/catalog/legacy";
import type { ColumnsSql } from "../../src/catalog/legacy";
import { catalogMigrations } from "../../src/catalog/migrations";

// The catalog as code from before regions, replicas and the rest created it.
const OLD = [
  {
    name: "test_old_dbs",
    up: "CREATE TABLE dbs (name TEXT PRIMARY KEY, created INTEGER NOT NULL, shards INTEGER NOT NULL, regions TEXT)",
    down: "SELECT 1;",
  },
] satisfies DurableMigrations;

// SqlStorage on node:sqlite, one statement at a time.
function sqlOn(db: DatabaseSync): ColumnsSql {
  return {
    exec: (query: string) => {
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all() : (statement.run(), []);

      return { toArray: () => rows.map((r) => ({ name: String(r.name) })) };
    },
  };
}

const columns = (db: DatabaseSync) =>
  db
    .prepare("PRAGMA table_info(dbs)")
    .all()
    .map((c) => `${String(c.name)} ${String(c.type)}`);

test("an old catalog gets every column it lacks, in order, and keeps its rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(OLD[0].up);
  db.exec("INSERT INTO dbs VALUES ('old', 1, 2, NULL)");
  addMissingColumns(sqlOn(db));
  addMissingColumns(sqlOn(db));

  const fresh = new DatabaseSync(":memory:");
  fresh.exec(catalogMigrations[0].up);
  expect(columns(db)).toEqual(columns(fresh));
  expect(db.prepare("SELECT name, shards, flavour FROM dbs").all()).toEqual([
    { name: "old", shards: 2, flavour: null },
  ]);
});

test("a new catalog is left to the migration", () => {
  const db = new DatabaseSync(":memory:");
  addMissingColumns(sqlOn(db));
  expect(columns(db)).toEqual([]);
});
