import { sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import type { WasmHost } from "./host/wasm-host";
import { messageOf } from "../shared";
import { commitProbe } from "./schema";
import type { VfsProbe } from "./types";

// Date.now only advances across I/O, which sync() is.
async function timed(storage: DurableObjectStorage, f: () => void): Promise<number> {
  const t = Date.now();
  f();
  await storage.sync();

  return Date.now() - t;
}

export async function commitTimes(
  storage: DurableObjectStorage,
  db: DrizzleSqliteDODatabase,
  n: number,
): Promise<number[]> {
  const times: number[] = [];

  for (let i = 0; i < n; i++) {
    const ms = await timed(storage, () =>
      db
        .insert(commitProbe)
        .values({ k: 0, v: i })
        .onConflictDoUpdate({ target: commitProbe.k, set: { v: i } })
        .run(),
    );

    times.push(ms);
  }

  return times.sort((a, b) => a - b);
}

export async function vfsTimes(
  storage: DurableObjectStorage,
  db: DrizzleSqliteDODatabase,
  host: WasmHost,
  mb: number,
): Promise<VfsProbe> {
  const chunk = crypto.getRandomValues(new Uint8Array(1 << 16));
  const out: VfsProbe = { autoVacuum: "" };

  try {
    out.autoVacuum = db.all<{ auto_vacuum: number }>(sql`PRAGMA auto_vacuum`);
  } catch (e) {
    out.autoVacuum = messageOf(e);
  }

  const write = (path: string) => {
    for (let i = 0; i < mb * 16; i++) host.appendFile(path, chunk);
    host.flushFiles();
  };

  out.writeAMs = await timed(storage, () => write("probe-a.bin"));
  out.writeBMs = await timed(storage, () => write("probe-b.bin"));
  out.deleteMiddleMs = await timed(storage, () => host.removeFile("probe-a.bin"));
  out.deleteEndMs = await timed(storage, () => host.removeFile("probe-b.bin"));

  return out;
}
