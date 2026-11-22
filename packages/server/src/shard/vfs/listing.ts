import type { Statements } from "./statements";
import type { FileEntry } from "./types";

/** Every file and directory with its stored size and rows: scanned once, then kept up to date by appends. */
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

  /** Chunks under `key` gained `bytes` bytes in `rows` new rows. */
  grew(key: string, bytes: number, rows: number): void {
    const entry = this.#files.get(key);

    if (entry) {
      entry.size += bytes;
      entry.rows += rows;
    }
  }

  /** Anything else changed: scan again on the next call. */
  reset(): void {
    this.#entries = null;
    this.#files.clear();
  }
}
