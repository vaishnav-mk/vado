// Durable Object SQL storage over node:sqlite, for unit tests in plain Node.
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { VfsStorage } from "./types";

type Row = Record<string, SqlStorageValue>;

type Binding = SqlStorageValue | Uint8Array;

// DO SQLite returns BLOBs as ArrayBuffer.
// SAFETY: readBigInts is off, so the rest is a number, a string or null.
const toStorage = (v: SQLOutputValue) => (v instanceof Uint8Array ? v.slice().buffer : (v as SqlStorageValue));

class FakeCursor<T extends Row> implements SqlStorageCursor<T> {
  readonly #rows: T[];
  #next = 0;
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;

  constructor(rows: T[], columnNames: string[], rowsWritten: number) {
    this.#rows = rows;
    this.columnNames = columnNames;
    this.rowsRead = rows.length;
    this.rowsWritten = rowsWritten;
  }

  next(): IteratorResult<T, undefined> {
    return this.#next < this.#rows.length
      ? { value: this.#rows[this.#next++], done: false }
      : { value: undefined, done: true };
  }

  toArray(): T[] {
    return this.#rows.slice(this.#next);
  }

  one(): T {
    if (this.#rows.length !== 1) throw new Error(`expected one row, got ${this.#rows.length}`);

    return this.#rows[0];
  }

  raw<U extends SqlStorageValue[]>(): IterableIterator<U> {
    // SAFETY: each row's values, in column order, are the U the caller asks for.
    return this.toArray()
      .map((row) => Object.values(row) as U)
      .values();
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.toArray().values();
  }
}

export function fakeStorage(): VfsStorage & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");

  const exec = <T extends Row>(query: string, ...bindings: Binding[]): SqlStorageCursor<T> => {
    const statements = query
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const s of statements.slice(0, -1)) db.exec(s);
    const statement = db.prepare(statements.at(-1) ?? "SELECT 1");
    const columns = statement.columns().map((c) => c.name);
    const input = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b));

    if (!columns.length) return new FakeCursor<T>([], [], Number(statement.run(...input).changes));

    const rows = statement.all(...input).map((row) => {
      const out: Row = {};

      for (const [k, v] of Object.entries(row)) out[k] = toStorage(v);

      return out;
    });

    // SAFETY: the caller names the row type its query returns, as with the real SqlStorage.
    return new FakeCursor(rows as T[], columns, 0);
  };

  let depth = 0;

  return {
    db,
    // SAFETY: the code under test only calls exec.
    sql: { exec } as SqlStorage,
    transactionSync: <T>(closure: () => T): T => {
      const name = `t${depth++}`;
      db.exec(`SAVEPOINT ${name}`);

      try {
        const result = closure();
        db.exec(`RELEASE ${name}`);

        return result;
      } catch (e) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw e;
      } finally {
        depth--;
      }
    },
  };
}
