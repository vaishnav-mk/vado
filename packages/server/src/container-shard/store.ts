import type { DurableMigrations } from "@durability/storage";
import * as v from "valibot";
import { migrate } from "../migrate";
import { settingsMigrations } from "../settings";

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

type Kind = typeof BASE | typeof LOG;

// replid and offset: the history and offset the base was taken at.
const GenerationSchema = v.object({
  gen: v.number(),
  replid: v.string(),
  offset: v.number(),
  master: v.optional(v.string()), // the history the log continues in
  shift: v.optional(v.number()), // master offset just before the log's first byte
});

export type Generation = v.InferOutput<typeof GenerationSchema>;

// Every sync takes a fresh generation (begin), so a retry never appends to rows a failed one left.
export class BoxStore {
  readonly #sql: SqlStorage;
  readonly sync: () => Promise<void>;
  readonly #seq = new Map<string, number>();
  readonly #bytes = new Map<string, number>();
  #building: number | null = null;
  #dropped: boolean;

  constructor(storage: Pick<DurableObjectStorage, "sql" | "transactionSync" | "sync">) {
    migrate(storage, [...boxMigrations, ...settingsMigrations]);
    this.#sql = storage.sql;
    this.sync = () => storage.sync();
    this.#dropped = this.#sql.exec("SELECT 1 FROM box_meta WHERE k = 'dropped'").toArray().length > 0;
  }

  begin(): number {
    const top = this.#sql.exec<{ g: number | null }>("SELECT max(gen) AS g FROM box_data").one().g ?? 0;

    this.#building = Math.max(top, this.current()?.gen ?? 0, this.#building ?? 0) + 1;

    return this.#building;
  }

  current(): Generation | null {
    const row = this.#sql.exec<{ v: string }>("SELECT v FROM box_meta WHERE k = 'current'").toArray()[0];

    return row ? v.parse(GenerationSchema, JSON.parse(row.v)) : null;
  }

  append(gen: number, kind: Kind, data: Uint8Array): void {
    const key = `${gen}.${kind}`;

    const seq =
      this.#seq.get(key) ??
      this.#sql
        .exec<{ s: number }>("SELECT ifnull(max(seq) + 1, 0) AS s FROM box_data WHERE gen = ? AND kind = ?", gen, kind)
        .one().s;

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
    this.#building = null;
    this.#forgetAllBut([next.gen]);
  }

  // Deletes about `budget` bytes of generations neither current nor being built; true while any remain.
  prune(budget: number): boolean {
    const keep = [this.current()?.gen ?? -1, this.#building ?? -1];

    this.#sql.exec(
      `DELETE FROM box_data WHERE (gen, kind, seq) IN (SELECT gen, kind, seq FROM (SELECT gen, kind, seq,
        sum(length(data)) OVER (ORDER BY gen, kind, seq) - length(data) AS before FROM box_data WHERE gen NOT IN (?, ?))
        WHERE before < ?)`,
      ...keep,
      budget,
    );
    this.#forgetAllBut(keep);

    return this.#sql.exec("SELECT 1 FROM box_data WHERE gen NOT IN (?, ?) LIMIT 1", ...keep).toArray().length > 0;
  }

  dropped(): boolean {
    return this.#dropped;
  }

  drop(): void {
    this.#sql.exec("DELETE FROM box_data");
    this.#sql.exec("INSERT OR REPLACE INTO box_meta (k, v) VALUES ('dropped', '1')");
    this.#dropped = true;
  }

  #forgetAllBut(gens: number[]): void {
    for (const cache of [this.#seq, this.#bytes])
      for (const key of cache.keys()) if (!gens.includes(Number(key.split(".")[0]))) cache.delete(key);
  }
}
