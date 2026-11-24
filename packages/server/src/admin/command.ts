import { replicaRegion } from "../catalog/placement";
import type { DatabaseRecord } from "../catalog/types";
import { keyIndexes, SUBSCRIBE } from "../protocol/commands";
import { decodeTyped } from "../protocol/decode";
import { shardOfSlot, slotOf } from "../protocol/slots";
import { coloOf } from "../catalog/regions";
import { commands } from "../router/command-table";
import { replicaResting } from "../router/isolate";
import { openLocal } from "../router/local";
import { COMMAND_STALL_MS, WAIT_MS } from "./config";
import type { CommandResult } from "./live-types";
import { encoder } from "../shared";

const NEEDS_A_CONNECTION = new Set([...SUBSCRIBE, "monitor", "multi", "watch", "reset", "quit", "hello"]);

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

  const raw = argv.map((a) => encoder.encode(a));
  const first = keyIndexes(table, cmd, raw)?.[0];

  const key = first === undefined ? null : argv[first],
    slot = first === undefined ? null : slotOf(raw[first]),
    shard = slot === null ? null : shardOfSlot(slot, db.shards);

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
      shard,
      colo,
      // The router's rule (router/routing.ts): a keyed, non-blocking read, unless this isolate saw the replica fail.
      replica:
        read &&
        shard !== null &&
        colo !== null &&
        !flags?.has("blocking") &&
        !replicaResting(db.name, shard, Date.now())
          ? replicaRegion(db, colo)
          : null,
      replication,
    };
  } finally {
    c.close();
  }
}
