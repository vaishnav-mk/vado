import type { DurableMigrations } from "@durability/storage";
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { indexRows, rowAt } from "../../../src/wasm-shard/vfs/chunks";
import { VFS_TAIL } from "../../../src/wasm-shard/vfs/config";
import { fakeStorage } from "./fake-storage";
import { addMissingColumns, migrate } from "../../../src/migrate";
import { vfsLegacy, vfsMigrations } from "../../../src/wasm-shard/vfs/migrations";
import { Vfs } from "../../../src/wasm-shard/vfs/vfs";

// The tables as objects from before migrations and chunk keys have them.
const [oldNodes, oldChunks] = [
  {
    name: "old_nodes",
    up: "CREATE TABLE vfs_node (path TEXT PRIMARY KEY, is_dir INTEGER NOT NULL, size INTEGER NOT NULL)",
    down: "SELECT 1",
  },
  {
    name: "old_chunks",
    up: "CREATE TABLE vfs_chunk (path TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, seq)) WITHOUT ROWID",
    down: "SELECT 1",
  },
] satisfies DurableMigrations;

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

const columns = (storage: ReturnType<typeof fakeStorage>, table: string) =>
  storage.sql
    .exec<{ name: string }>(`PRAGMA table_info(${table})`)
    .toArray()
    .map((c) => c.name);

test("row index arithmetic", () => {
  const rows = indexRows([
    { seq: 0, len: 10 },
    { seq: 1, len: 5 },
  ]);

  assert.deepEqual(rows, [
    { seq: 0, start: 0, len: 10 },
    { seq: 1, start: 10, len: 5 },
  ]);
  assert.equal(rowAt(rows, 0), 0);
  assert.equal(rowAt(rows, 9), 0);
  assert.equal(rowAt(rows, 10), 1);
  assert.equal(rowAt(rows, 99), 1);
  assert.equal(rowAt([], 0), -1);
});

test("migrations create the tables once, and old tables get the chunks column", () => {
  const fresh = fakeStorage();
  migrate(fresh, vfsMigrations, vfsLegacy);
  migrate(fresh, vfsMigrations, vfsLegacy);
  assert.deepEqual(columns(fresh, "vfs_node"), ["path", "is_dir", "size", "chunks"]);
  assert.deepEqual(columns(fresh, "vfs_trash"), ["key"]);
  assert.deepEqual(
    fresh.sql
      .exec<{ name: string }>("SELECT name FROM durability_migrations")
      .toArray()
      .map((r) => r.name),
    ["vfs_0001_tables"],
  );

  const old = fakeStorage();
  old.db.exec(oldNodes.up);
  addMissingColumns(old.sql, vfsLegacy);
  addMissingColumns(old.sql, vfsLegacy);
  assert.deepEqual(columns(old, "vfs_node"), ["path", "is_dir", "size", "chunks"]);
});

test("files from before chunk keys stay readable", () => {
  const storage = fakeStorage();
  storage.db.exec(oldNodes.up);
  storage.db.exec(oldChunks.up);
  storage.db.exec("INSERT INTO vfs_node VALUES ('old.aof', 0, 0)");
  storage.db.prepare("INSERT INTO vfs_chunk VALUES ('old.aof', 0, ?)").run(bytes(3, 7));
  const vfs = new Vfs(storage);
  assert.deepEqual(vfs.read("old.aof", 0, 10), bytes(3, 7));
  vfs.append("old.aof", bytes(2, 8));
  vfs.flush();
  assert.deepEqual(vfs.read("old.aof", 0, 10), new Uint8Array([7, 7, 7, 8, 8]));
});

test("appends grow the last row in place, and reads see every flush", () => {
  const storage = fakeStorage();
  const vfs = new Vfs(storage);

  for (let i = 0; i < 10; i++) {
    vfs.append("dir/a.aof", bytes(100, i));
    vfs.flush();
    assert.equal(vfs.read("dir/a.aof", i * 100, 100)?.[99], i); // keeps the row index across flushes
  }

  assert.equal(vfs.stats.writes, 10);
  assert.ok(vfs.stats.rowsWritten >= 12);
  assert.deepEqual(vfs.listing(), [
    { path: "dir", is_dir: 1, size: 0, rows: 0 },
    { path: "dir/a.aof", is_dir: 0, size: 1000, rows: 1 },
  ]);

  vfs.append("dir/a.aof", bytes(VFS_TAIL, 1));
  vfs.flush();
  vfs.append("dir/a.aof", bytes(5, 2));
  vfs.flush();
  assert.equal(vfs.size("dir/a.aof"), 1005 + VFS_TAIL);
  assert.deepEqual(vfs.listing(), new Vfs(storage).listing()); // the kept listing matches a fresh scan
  assert.deepEqual(vfs.listing()[1], { path: "dir/a.aof", is_dir: 0, size: 1005 + VFS_TAIL, rows: 3 });
  assert.deepEqual(vfs.read("dir/a.aof", 995, 10), new Uint8Array([9, 9, 9, 9, 9, 1, 1, 1, 1, 1]));
});

test("a removed file's chunks go to the trash, and the sweep deletes them", () => {
  const storage = fakeStorage();
  const vfs = new Vfs(storage);
  let trashed = 0;
  vfs.onTrash = () => trashed++;
  vfs.append("b.rdb", bytes(VFS_TAIL * 3, 1));
  vfs.flush();
  vfs.remove("b.rdb");
  assert.equal(trashed, 1);
  assert.equal(vfs.read("b.rdb", 0, 1), null);
  assert.deepEqual(vfs.listing(), []);

  while (vfs.sweep(1));
  assert.equal(storage.sql.exec("SELECT 1 FROM vfs_chunk").toArray().length, 0);
  assert.equal(storage.sql.exec("SELECT 1 FROM vfs_trash").toArray().length, 0);
});
