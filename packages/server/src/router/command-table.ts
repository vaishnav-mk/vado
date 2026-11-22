import { objectOptions } from "../catalog/placement";
import type { Flavour } from "../catalog/types";
import { commandTable } from "../protocol/commands";
import { decodeAll } from "../protocol/decode";
import type { CommandTable } from "../protocol/types";
import type { ShardStub } from "./types";

// Per isolate, cached as a promise: hundreds of connections landing on a cold isolate would otherwise all ask.
const tables = new Map<Flavour, Promise<CommandTable>>();

async function ask(meta: ShardStub): Promise<CommandTable> {
  // runRaw: run's RPC result type is too deep for the checker, and it's the same reply.
  const [reply] = decodeAll(await meta.runRaw([["COMMAND"]]));

  return commandTable(reply);
}

/** The command table of a server flavour, from its own COMMAND. */
export function commands(env: Env, flavour: Flavour = "valkey"): Promise<CommandTable> {
  let table = tables.get(flavour);

  if (!table) {
    // Every server of a flavour answers COMMAND the same way; a dedicated object keeps it off data shards.
    const name = flavour === "valkey" ? "__meta" : `__meta.${flavour}`;
    table = ask(env.SHARD.getByName(name, objectOptions(env)));
    table.catch(() => tables.delete(flavour));
    tables.set(flavour, table);
  }

  return table;
}
