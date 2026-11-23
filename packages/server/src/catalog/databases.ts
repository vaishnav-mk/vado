import { IsolateCache } from "../isolate-cache";
import { flavoursOf } from "../shard/servers";
import type { DatabaseRecord, Flavour, Hint } from "./types";

// A record never changes once created, so each isolate asks once per database.
const records = new IsolateCache<string, DatabaseRecord>();

export const catalogStub = (env: Env) => env.CATALOG.getByName("catalog");

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

export const forget = (name: string): boolean => records.delete(name);

// Uncached, so the dashboard sees a drop that this isolate's cache doesn't.
export const current = (env: Env, name: string): Promise<DatabaseRecord | null> => catalogStub(env).find(name);

export async function existing(env: Env, name: string): Promise<DatabaseRecord | null> {
  const db = await current(env, name);

  return db && !db.dropped ? db : null;
}

export async function lookup(env: Env, name: string): Promise<DatabaseRecord | null> {
  return records.peek(name) ?? (await current(env, name));
}

export function parseFlavour(env: Pick<Env, "BOX">, asked: string): Flavour {
  const flavours = flavoursOf(env.BOX);
  const flavour = flavours.find((f) => f === asked);

  if (!flavour) throw new Error(`this build runs ${flavours.join(" or ")}, not ${asked}`);

  return flavour;
}
