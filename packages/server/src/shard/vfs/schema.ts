import { customType, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// DO SQLite returns BLOBs as ArrayBuffer.
const bytes = customType<{ data: Uint8Array; driverData: ArrayBuffer }>({
  dataType: () => "blob",
  fromDriver: (value) => new Uint8Array(value),
});

// `size` is always 0 and never read, but NOT NULL. `chunks` is the key the file's chunks live under; NULL means
// the file's own path (files from before keys).
export const vfsNode = sqliteTable("vfs_node", {
  path: text("path").primaryKey(),
  isDir: integer("is_dir").notNull(),
  size: integer("size").notNull(),
  chunks: text("chunks"),
});

// WITHOUT ROWID in the DDL (migrations.ts): drizzle can't declare it.
export const vfsChunk = sqliteTable(
  "vfs_chunk",
  {
    path: text("path").notNull(),
    seq: integer("seq").notNull(),
    data: bytes("data").notNull(),
  },
  (table) => [primaryKey({ columns: [table.path, table.seq] })],
);

// Keys of deleted files whose chunks the sweep hasn't removed yet.
export const vfsTrash = sqliteTable("vfs_trash", { key: text("key").primaryKey() });
