// Server functions over the ADMIN binding. Reading is public; every change checks the session first.
// Inputs are checked for shape and size here; the Admin entrypoint enforces the exact rules (names, shard
// counts, regions) and its error messages reach the page as they are.
import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { requireSession } from "./session";

const name = z.string().min(1).max(63);

export const listDatabases = createServerFn({ method: "GET" }).handler(() => env.ADMIN.databases());

/** Database `name`, or null if there is none (or the name can't be one). */
export const getDatabase = createServerFn({ method: "GET" })
  .validator(z.object({ name: z.string().max(200) }))
  .handler(({ data }) => env.ADMIN.database(data.name).catch(() => null));

export const listRegions = createServerFn({ method: "GET" }).handler(() => env.ADMIN.regions());

export const createDatabase = createServerFn({ method: "POST" })
  .validator(z.object({ name, shards: z.number().int().min(1).max(64), place: z.string().min(1).max(16), replicas: z.boolean() }))
  .handler(async ({ data }) => {
    await requireSession();
    return env.ADMIN.create(data);
  });

export const restartShard = createServerFn({ method: "POST" })
  .validator(z.object({ name, shard: z.number().int().min(0).max(16383) }))
  .handler(async ({ data }) => {
    await requireSession();
    await env.ADMIN.restart(data.name, data.shard);
    return null;
  });

export const startTest = createServerFn({ method: "POST" })
  .validator(z.object({ name, level: z.enum(["light", "medium", "heavy"]), from: z.string().min(1).max(16) }))
  .handler(async ({ data }) => {
    await requireSession();
    return env.ADMIN.startTest(data.name, data.level, data.from);
  });

export const stopTest = createServerFn({ method: "POST" })
  .validator(z.object({ name }))
  .handler(async ({ data }) => {
    await requireSession();
    await env.ADMIN.stopTest(data.name);
    return null;
  });

export const runCommand = createServerFn({ method: "POST" })
  .validator(z.object({ name, argv: z.array(z.string().max(64 * 1024)).min(1).max(256) }))
  .handler(async ({ data }) => {
    await requireSession();
    return env.ADMIN.command(data.name, data.argv);
  });
