import type { Statements } from "./statements";
import type { FileEntry } from "./types";

export class Listing {
  readonly #statements: Statements;
  #entries: FileEntry[] | null = null;
  readonly #files = new Map<string, FileEntry>(); // by chunk key

  constructor(statements: Statements) {
    this.#statements = statements;
  }

  entries(): FileEntry[] {
    if (!this.#entries) {
      this.#entries = [];

      for (const row of this.#statements.listing.all()) {
        const entry = { path: row.path, is_dir: row.isDir, size: row.size, rows: row.rows };
        this.#entries.push(entry);

        if (!row.isDir) this.#files.set(row.key, entry);
      }
    }

    return this.#entries.map((e) => ({ ...e }));
  }

  grew(key: string, bytes: number, rows: number): void {
    const entry = this.#files.get(key);

    if (entry) {
      entry.size += bytes;
      entry.rows += rows;
    }
  }

  reset(): void {
    this.#entries = null;
    this.#files.clear();
  }
}
