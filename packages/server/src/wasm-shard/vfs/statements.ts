import { and, asc, desc, eq, gte, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { VFS_SWEEP_ROWS } from "./config";
import { vfsChunk, vfsNode, vfsTrash } from "./schema";
import type { VfsStats, VfsStorage } from "./types";

const key = sql.placeholder("key");
const seq = sql.placeholder("seq");
const path = sql.placeholder("path");
const fileKey = sql<string>`coalesce(${vfsNode.chunks}, ${vfsNode.path})`;
const fileSize = sql<number>`coalesce((SELECT sum(length(${vfsChunk.data})) FROM ${vfsChunk} WHERE ${vfsChunk.path} = ${fileKey}), 0)`;
const fileRows = sql<number>`(SELECT count(*) FROM ${vfsChunk} WHERE ${vfsChunk.path} = ${fileKey})`;
const length = sql<number>`length(${vfsChunk.data})`;

// drizzle's prepared run() drops the cursor, so the client it gets counts what every statement writes (billed).
function counting(storage: VfsStorage, stats: VfsStats): DurableObjectStorage {
  const client = {
    sql: {
      exec: (query: string, ...bindings: SqlStorageValue[]) => {
        const cursor = storage.sql.exec(query, ...bindings);
        stats.rowsWritten += cursor.rowsWritten;

        return cursor;
      },
    },
    transactionSync: <T>(closure: () => T) => storage.transactionSync(closure),
  };

  // SAFETY: drizzle's durable-sqlite session only calls sql.exec and transactionSync on its client.
  return client as DurableObjectStorage;
}

// Built once: the hot ones run inside wasm fd_write on every AOF append.
export function prepareStatements(storage: VfsStorage, stats: VfsStats) {
  const db = drizzle(counting(storage, stats));

  const ofKey = eq(vfsChunk.path, key);
  const chunkAt = and(ofKey, eq(vfsChunk.seq, seq));
  const rowLengths = () => db.select({ seq: vfsChunk.seq, len: length }).from(vfsChunk).where(ofKey);

  return {
    updateChunk: db
      .update(vfsChunk)
      .set({ data: sql`${sql.placeholder("data")}` })
      .where(chunkAt)
      .prepare(),
    insertChunk: db
      .insert(vfsChunk)
      .values({ path: key, seq, data: sql.placeholder("data") })
      .prepare(),
    readChunk: db.select({ data: vfsChunk.data }).from(vfsChunk).where(chunkAt).limit(1).prepare(),
    chunkRows: rowLengths().orderBy(asc(vfsChunk.seq)).prepare(),
    lastChunk: db
      .select({ seq: vfsChunk.seq, data: vfsChunk.data })
      .from(vfsChunk)
      .where(ofKey)
      .orderBy(desc(vfsChunk.seq))
      .limit(1)
      .prepare(),
    lastSeq: db
      .select({ seq: sql<number | null>`max(${vfsChunk.seq})` })
      .from(vfsChunk)
      .where(ofKey)
      .limit(1)
      .prepare(),
    deleteChunks: db.delete(vfsChunk).where(ofKey).prepare(),
    node: db
      .select({ isDir: vfsNode.isDir, key: fileKey, size: fileSize })
      .from(vfsNode)
      .where(eq(vfsNode.path, path))
      .limit(1)
      .prepare(),
    insertFile: db.insert(vfsNode).values({ path, isDir: 0, size: 0, chunks: key }).prepare(),
    insertDir: db.insert(vfsNode).values({ path, isDir: 1, size: 0 }).prepare(),
    deleteNode: db.delete(vfsNode).where(eq(vfsNode.path, path)).prepare(),
    renameNode: db
      .update(vfsNode)
      .set({ path: sql`${sql.placeholder("to")}`, chunks: sql`coalesce(${vfsNode.chunks}, ${path})` })
      .where(eq(vfsNode.path, path))
      .prepare(),
    children: db
      .select({ path: vfsNode.path, isDir: vfsNode.isDir })
      .from(vfsNode)
      .where(like(vfsNode.path, sql.placeholder("pattern")))
      .orderBy(asc(vfsNode.path))
      .prepare(),
    listing: db
      .select({ path: vfsNode.path, isDir: vfsNode.isDir, key: fileKey, size: fileSize, rows: fileRows })
      .from(vfsNode)
      .orderBy(asc(vfsNode.path))
      .prepare(),
    trash: db.insert(vfsTrash).values({ key }).onConflictDoNothing().prepare(),
    firstTrash: db.select({ key: vfsTrash.key }).from(vfsTrash).limit(1).prepare(),
    untrash: db.delete(vfsTrash).where(eq(vfsTrash.key, key)).prepare(),
    trashRows: rowLengths().orderBy(desc(vfsChunk.seq)).limit(VFS_SWEEP_ROWS).prepare(),
    deleteChunksFrom: db
      .delete(vfsChunk)
      .where(and(ofKey, gte(vfsChunk.seq, seq)))
      .prepare(),
  };
}

export type Statements = ReturnType<typeof prepareStatements>;
