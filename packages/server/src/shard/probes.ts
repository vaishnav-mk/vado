// Test hooks behind the bench API's commit and vfs probes.
import { sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { ValkeyHost } from "./host/valkey-host";
import { commitProbe } from "./schema";

export interface VfsProbe {
  autoVacuum: { auto_vacuum: number }[] | string;
  writeAMs?: number;
  writeBMs?: number;
  deleteMiddleMs?: number;
  deleteEndMs?: number;
}

/** How long each of `n` one-row writes takes to be confirmed (what every reply waits for), sorted. */
export async function commitTimes(
  storage: DurableObjectStorage,
  db: DrizzleSqliteDODatabase,
  n: number,
): Promise<number[]> {
  const times: number[] = [];

  for (let i = 0; i < n; i++) {
    const t0 = Date.now(); // Date.now only advances across I/O, which sync() is
    db.insert(commitProbe)
      .values({ k: 0, v: i })
      .onConflictDoUpdate({ target: commitProbe.k, set: { v: i } })
      .run();
    await storage.sync();
    times.push(Date.now() - t0);
  }

  return times.sort((a, b) => a - b);
}

/** Storage commit times for writing two `mb` MB files, then deleting the first (now in the middle of the database)
 *  and the second (at its end). */
export async function vfsTimes(
  storage: DurableObjectStorage,
  db: DrizzleSqliteDODatabase,
  host: ValkeyHost,
  mb: number,
): Promise<VfsProbe> {
  const chunk = crypto.getRandomValues(new Uint8Array(1 << 16));
  const out: VfsProbe = { autoVacuum: "" };

  try {
    out.autoVacuum = db.all<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`);
  } catch (e) {
    out.autoVacuum = e instanceof Error ? e.message : String(e);
  }

  const timed = async (f: () => void) => {
    const t = Date.now();
    f();
    await storage.sync();

    return Date.now() - t;
  };

  const write = (path: string) => {
    for (let i = 0; i < mb * 16; i++) host.appendFile(path, chunk);
    host.flushFiles();
  };

  out.writeAMs = await timed(() => write("probe-a.bin"));
  out.writeBMs = await timed(() => write("probe-b.bin"));
  out.deleteMiddleMs = await timed(() => host.removeFile("probe-a.bin"));
  out.deleteEndMs = await timed(() => host.removeFile("probe-b.bin"));

  return out;
}
