import { replicaRegion } from "../catalog/placement";
import type { DatabaseRecord } from "../catalog/types";
import { keyIndexes } from "../protocol/commands";
import { decodeTyped } from "../protocol/decode";
import { shardOfSlot, slotOf } from "../protocol/slots";
import { coloOf } from "../replication/regions";
import { commands } from "../router/command-table";
import { openLocal } from "../router/local";
import { COMMAND_STALL_MS, WAIT_MS } from "./config";
import type { CommandResult } from "./live-types";
import { encoder } from "../shared";

const NEEDS_A_CONNECTION = new Set([
  "subscribe",
  "psubscribe",
  "ssubscribe",
  "monitor",
  "multi",
  "watch",
  "reset",
  "quit",
  "hello",
]);

const REFUSED = new Map([
  ["keys", "KEYS returns every key at once; use SCAN"],
  ["flushall", "FLUSHALL wipes the database; run it from a client"],
  ["flushdb", "FLUSHDB wipes the database; run it from a client"],
]);

export async function command(env: Env, db: DatabaseRecord, argv: string[]): Promise<CommandResult> {
  const cmd = argv[0].toLowerCase();

  if (NEEDS_A_CONNECTION.has(cmd))
    throw new Error(`${argv[0].toUpperCase()} needs a client that keeps its connection open, such as valkey-cli`);
  const refused = REFUSED.get(cmd);

  if (refused) throw new Error(refused);
  const table = await commands(env, db.flavour);
  const flags = table.get(cmd)?.flags;

  const idx = keyIndexes(
    table,
    cmd,
    argv.map((a) => encoder.encode(a)),
  );

  const key = idx?.length ? argv[idx[0]] : null,
    slot = key === null ? null : slotOf(encoder.encode(key));

  const write = !!flags?.has("write"),
    read = !!flags?.has("readonly");

  const [c, colo] = await Promise.all([openLocal(env, db.name, COMMAND_STALL_MS), coloOf().catch(() => null)]);

  try {
    // Warm the new connection's path so the time shown is the command's; a replicated write warms with a DEL in its slot.
    if (key !== null)
      await c.call(write && db.replicas && !/[{}]/.test(key) ? ["DEL", `dashboard:warm:{${key}}`] : ["EXISTS", key]);
    const t0 = performance.now();
    await c.send(argv);
    const [reply] = await c.read(1, decodeTyped);
    const ms = performance.now() - t0;
    let replication: CommandResult["replication"] = null;

    if (write && db.replicas && reply.type !== "error") {
      const t1 = performance.now();
      await c.send(["WAIT", String(db.replicas.length), String(WAIT_MS)]);
      const [acked] = await c.read(1, decodeTyped);
      replication =
        acked.type === "integer" ? { acked: acked.value, of: db.replicas.length, ms: performance.now() - t1 } : null;
    }

    return {
      reply,
      ms,
      write,
      read,
      key,
      slot,
      shard: slot === null ? null : shardOfSlot(slot, db.shards),
      colo,
      replica: read && colo !== null ? replicaRegion(db, colo) : null,
      replication,
    };
  } finally {
    c.close();
  }
}
