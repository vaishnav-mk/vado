import { objectOptions } from "../catalog/placement";
import type { Flavour } from "../catalog/types";
import { commandTable } from "../protocol/commands";
import { decodeAll } from "../protocol/decode";
import { IsolateCache } from "../isolate-cache";
import type { CommandTable } from "../protocol/types";
import type { ShardStub } from "./types";

const tables = new IsolateCache<Flavour, CommandTable>();

async function ask(meta: ShardStub): Promise<CommandTable> {
  // runRaw: run's RPC result type is too deep for the checker.
  const [reply] = decodeAll(await meta.runRaw([["COMMAND"]]));

  // An error reply would cache an empty table, making every command unknown.
  if (!Array.isArray(reply)) throw new Error(`COMMAND failed: ${JSON.stringify(reply)}`);

  return commandTable(reply);
}

export function commands(env: Env, flavour: Flavour = "valkey"): Promise<CommandTable> {
  // A dedicated object keeps COMMAND off data shards; every server of a flavour answers it the same.
  const name = flavour === "valkey" ? "__meta" : `__meta.${flavour}`;

  return tables.get(flavour, () => ask(env.SHARD.getByName(name, objectOptions(env))));
}
