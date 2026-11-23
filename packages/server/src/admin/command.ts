// One command from the dashboard: what it replied (with its RESP2 type) and where it went.
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

// One-shot calls can't use these: they need a connection that stays open.
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

// Not from a button: KEYS returns every key at once (SCAN pages through them), and a flush wipes the database.
const REFUSED = new Map([
  ["keys", "KEYS returns every key at once; use SCAN"],
  ["flushall", "FLUSHALL wipes the database; run it from a client"],
  ["flushdb", "FLUSHDB wipes the database; run it from a client"],
]);

/** Runs `argv` on `db`. For a write on a replicated database, also says how many replicas had it within WAIT_MS. */
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
    // The connection is new, so its router hasn't reached this key's shard (or replica) yet. Warm that path with a
    // command that changes nothing and goes where this one will, so the time shown is the command's: a read of the
    // key, or for a write that a read would send elsewhere (to a replica), a delete of a dashboard-only key in the
    // same slot (`{key}` is a hash tag for key's slot).
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
      // A WAIT that errors says nothing about the replicas.
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
