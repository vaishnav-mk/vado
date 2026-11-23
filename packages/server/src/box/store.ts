import type { DurableMigrations } from "@durability/storage";
import * as v from "valibot";
import { migrate } from "../migrate";

const boxMigrations = [
  {
    name: "box_0001_tables",
    up: `CREATE TABLE IF NOT EXISTS box_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS box_data (gen INTEGER NOT NULL, kind INTEGER NOT NULL, seq INTEGER NOT NULL,
  data BLOB NOT NULL, PRIMARY KEY (gen, kind, seq)) WITHOUT ROWID;`,
    down: "SELECT 1;",
  },
] satisfies DurableMigrations;

export const BASE = 0;
export const LOG = 1;

export type Kind = typeof BASE | typeof LOG;

// replid and offset: the server history and offset the base was taken at. master: the history the log goes on in now,
// and shift: its offset less the log's length, so the log's last byte is at shift + logged bytes (link.ts). A restored
// server takes over with a history and offsets of its own.
const GenerationSchema = v.object({
  gen: v.number(),
  replid: v.string(),
  offset: v.number(),
  master: v.optional(v.string()),
  shift: v.optional(v.number()),
});

export type Generation = v.InferOutput<typeof GenerationSchema>;

// A generation is one base RDB plus the replication stream after it. Only a committed switch makes it current, so
// a sync cut short leaves the previous generation whole.
export class BoxStore {
  readonly #sql: SqlStorage;
  readonly #seq = new Map<string, number>();
  readonly #bytes = new Map<string, number>();

  constructor(storage: Pick<DurableObjectStorage, "sql" | "transactionSync">) {
    migrate(storage, boxMigrations);
    this.#sql = storage.sql;
    const current = this.current()?.gen ?? 0;

    this.#sql.exec("DELETE FROM box_data WHERE gen > ?", current);
  }

  current(): Generation | null {
    const row = this.#sql.exec<{ v: string }>("SELECT v FROM box_meta WHERE k = 'current'").toArray()[0];

    return row ? v.parse(GenerationSchema, JSON.parse(row.v)) : null;
  }

  append(gen: number, kind: Kind, data: Uint8Array): void {
    const key = `${gen}.${kind}`;
    const seq = this.#seq.get(key) ?? this.#lastSeq(gen, kind) + 1;

    const before = this.bytes(gen, kind); // read before the insert, or the first count includes this row twice

    this.#sql.exec("INSERT INTO box_data (gen, kind, seq, data) VALUES (?, ?, ?, ?)", gen, kind, seq, data);
    this.#seq.set(key, seq + 1);
    this.#bytes.set(key, before + data.length);
  }

  *chunks(gen: number, kind: Kind): Generator<Uint8Array> {
    const rows = this.#sql.exec<{ data: ArrayBuffer }>(
      "SELECT data FROM box_data WHERE gen = ? AND kind = ? ORDER BY seq",
      gen,
      kind,
    );

    for (const row of rows) yield new Uint8Array(row.data);
  }

  bytes(gen: number, kind: Kind): number {
    const key = `${gen}.${kind}`;
    const known = this.#bytes.get(key);

    if (known !== undefined) return known;

    const n =
      this.#sql
        .exec<{ n: number | null }>("SELECT sum(length(data)) AS n FROM box_data WHERE gen = ? AND kind = ?", gen, kind)
        .one().n ?? 0;

    this.#bytes.set(key, n);

    return n;
  }

  switchTo(next: Generation): void {
    this.#sql.exec("INSERT OR REPLACE INTO box_meta (k, v) VALUES ('current', ?)", JSON.stringify(next));
    this.#sql.exec("DELETE FROM box_data WHERE gen < ?", next.gen);

    for (const cache of [this.#seq, this.#bytes])
      for (const key of cache.keys()) if (Number(key.split(".")[0]) < next.gen) cache.delete(key);
  }

  dropped(): boolean {
    return this.#sql.exec("SELECT 1 FROM box_meta WHERE k = 'dropped'").toArray().length > 0;
  }

  drop(): void {
    this.#sql.exec("DELETE FROM box_data");
    this.#sql.exec("INSERT OR REPLACE INTO box_meta (k, v) VALUES ('dropped', '1')");
  }

  #lastSeq(gen: number, kind: Kind): number {
    return (
      this.#sql
        .exec<{ s: number | null }>("SELECT max(seq) AS s FROM box_data WHERE gen = ? AND kind = ?", gen, kind)
        .one().s ?? -1
    );
  }
}
