// Reading is public; every change checks who is signed in first. valibot checks shape and size here; Admin enforces
// the exact rules (names, shard counts, regions) and its messages reach the page as they are.
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { Admin, FLAVOURS } from "@vado/server";
import type { CommandResult, Database, Options, TestView } from "../lib/types";
import { requireUser } from "./access";

const admin = () => new Admin(env);

const name = v.pipe(v.string(), v.minLength(1), v.maxLength(63));

export const listDatabases = createServerFn({ method: "GET" }).handler((): Promise<Database[]> => admin().databases());

/** Database `name`, or null if there is none (or the name can't be one). */
export const getDatabase = createServerFn({ method: "GET" })
  .validator(v.object({ name: v.pipe(v.string(), v.maxLength(200)) }))
  .handler(({ data }): Promise<Database | null> =>
    admin()
      .database(data.name)
      .catch(() => null),
  );

/** The regions a database can use, and the servers this build runs. */
export const listOptions = createServerFn({ method: "GET" }).handler((): Options => ({
  regions: admin().regions(),
  flavours: FLAVOURS,
}));

export const createDatabase = createServerFn({ method: "POST" })
  .validator(
    v.object({
      name,
      shards: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(64)),
      place: v.pipe(v.string(), v.minLength(1), v.maxLength(16)),
      replicas: v.boolean(),
      flavour: v.pipe(v.string(), v.maxLength(16)),
    }),
  )
  .handler(async ({ data }): Promise<Database> => {
    await requireUser();

    return await admin().create(data);
  });

export const restartShard = createServerFn({ method: "POST" })
  .validator(v.object({ name, shard: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(16383)) }))
  .handler(async ({ data }) => {
    await requireUser();
    await admin().restart(data.name, data.shard);

    return null;
  });

export const startTest = createServerFn({ method: "POST" })
  .validator(
    v.object({
      name,
      level: v.picklist(["light", "medium", "heavy"]),
      from: v.pipe(v.string(), v.minLength(1), v.maxLength(16)),
    }),
  )
  .handler(async ({ data }): Promise<TestView> => {
    await requireUser();

    return await admin().startTest(data.name, data.level, data.from);
  });

export const stopTest = createServerFn({ method: "POST" })
  .validator(v.object({ name }))
  .handler(async ({ data }) => {
    await requireUser();
    await admin().stopTest(data.name);

    return null;
  });

export const runCommand = createServerFn({ method: "POST" })
  .validator(
    v.object({
      name,
      argv: v.pipe(v.array(v.pipe(v.string(), v.maxLength(64 * 1024))), v.minLength(1), v.maxLength(256)),
    }),
  )
  .handler(async ({ data }): Promise<CommandResult> => {
    await requireUser();

    return await admin().command(data.name, data.argv);
  });
