import { objectOptions } from "../catalog/placement";
import type { Flavour } from "../catalog/types";
import { commandTable } from "../protocol/commands";
import { decodeAll } from "../protocol/decode";
import { IsolateCache } from "../isolate-cache";
import type { CommandTable } from "../protocol/types";
import type { ShardStub } from "./types";

const tables = new IsolateCache<Flavour, CommandTable>();

async function ask(meta: ShardStub): Promise<CommandTable> {
  // runRaw: run's RPC result type is too deep for the checker, and it's the same reply.
  const [reply] = decodeAll(await meta.runRaw([["COMMAND"]]));

  // An error reply would make an empty table, and cached, every command unknown.
  if (!Array.isArray(reply)) throw new Error(`COMMAND failed: ${JSON.stringify(reply)}`);

  return commandTable(reply);
}

/** The command table of a server flavour, from its own COMMAND. */
export function commands(env: Env, flavour: Flavour = "valkey"): Promise<CommandTable> {
  // Every server of a flavour answers COMMAND the same way; a dedicated object keeps it off data shards.
  const name = flavour === "valkey" ? "__meta" : `__meta.${flavour}`;

  return tables.get(flavour, () => ask(env.SHARD.getByName(name, objectOptions(env))));
}
