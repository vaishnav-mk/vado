// The dashboard's server functions, over @vado/server's Admin. Reading is public; every change checks who is signed
// in first. Inputs are checked for shape and size here; Admin enforces the exact rules (names, shard counts,
// regions) and its error messages reach the page as they are.
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { Admin, FLAVOURS } from "@vado/server";
import type { CommandResult, Database, Options, TestView } from "../lib/types";
import { requireUser } from "./access";

const admin = () => new Admin(env);

const name = z.string().min(1).max(63);

export const listDatabases = createServerFn({ method: "GET" }).handler((): Promise<Database[]> => admin().databases());

/** Database `name`, or null if there is none (or the name can't be one). */
export const getDatabase = createServerFn({ method: "GET" })
  .validator(z.object({ name: z.string().max(200) }))
  .handler(({ data }): Promise<Database | null> => admin().database(data.name).catch(() => null));

/** The regions a database can use, and the servers this build runs. */
export const listOptions = createServerFn({ method: "GET" }).handler((): Options => ({ regions: admin().regions(), flavours: FLAVOURS }));

export const createDatabase = createServerFn({ method: "POST" })
  .validator(z.object({ name, shards: z.number().int().min(1).max(64), place: z.string().min(1).max(16), replicas: z.boolean(), flavour: z.string().max(16) }))
  .handler(async ({ data }): Promise<Database> => {
    await requireUser();
    return await admin().create(data);
  });

export const restartShard = createServerFn({ method: "POST" })
  .validator(z.object({ name, shard: z.number().int().min(0).max(16383) }))
  .handler(async ({ data }) => {
    await requireUser();
    await admin().restart(data.name, data.shard);
    return null;
  });

export const startTest = createServerFn({ method: "POST" })
  .validator(z.object({ name, level: z.enum(["light", "medium", "heavy"]), from: z.string().min(1).max(16) }))
  .handler(async ({ data }): Promise<TestView> => {
    await requireUser();
    return await admin().startTest(data.name, data.level, data.from);
  });

export const stopTest = createServerFn({ method: "POST" })
  .validator(z.object({ name }))
  .handler(async ({ data }) => {
    await requireUser();
    await admin().stopTest(data.name);
    return null;
  });

export const runCommand = createServerFn({ method: "POST" })
  .validator(z.object({ name, argv: z.array(z.string().max(64 * 1024)).min(1).max(256) }))
  .handler(async ({ data }): Promise<CommandResult> => {
    await requireUser();
    return await admin().command(data.name, data.argv);
  });
