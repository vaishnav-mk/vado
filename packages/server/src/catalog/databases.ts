// A database's record from the catalog, cached per isolate.
import { IsolateCache } from "../isolate-cache";
import type { DatabaseRecord, Flavour, Hint } from "./types";

// A record never changes once created, so each isolate asks the catalog once per database.
const records = new IsolateCache<string, DatabaseRecord>();

export const catalogStub = (env: Env) => env.CATALOG.getByName("catalog");

/** The database's record, created with these settings if it doesn't exist yet. */
export function database(
  env: Env,
  name: string,
  shards?: number,
  regions?: Hint[],
  replicas?: Hint[],
  classes?: number,
  secret?: string | null,
  flavour?: Flavour,
): Promise<DatabaseRecord> {
  return records.get(name, () => catalogStub(env).get(name, shards, regions, replicas, classes, secret, flavour));
}

/** Forgets this isolate's copy of a database's record (it was dropped). */
export const forget = (name: string): boolean => records.delete(name);

/** The catalog's record of a database, dropped or not (null if none), never cached: for the dashboard, which must
 *  see a drop that this isolate's cache doesn't. */
export const current = (env: Env, name: string): Promise<DatabaseRecord | null> => catalogStub(env).find(name);

/** The database's record if it exists (null if not): unlike database(), never creates one. */
export async function lookup(env: Env, name: string): Promise<DatabaseRecord | null> {
  return records.peek(name) ?? (await current(env, name));
}
