import { objectOptions } from "../catalog/placement";
import { serverOf } from "../catalog/flavours";
import type { Flavour, Server } from "../catalog/types";
import { commandTable } from "../protocol/commands";
import { decodeAll } from "../protocol/decode";
import { IsolateCache } from "../isolate-cache";
import type { CommandTable } from "../protocol/types";
import type { ShardStub } from "./types";

const tables = new IsolateCache<Server, CommandTable>();

async function ask(meta: ShardStub): Promise<CommandTable> {
  // runRaw: run's RPC result type is too deep for the checker.
  const [reply] = decodeAll(await meta.runRaw([["COMMAND"]]));

  // An error reply would cache an empty table, making every command unknown.
  if (!Array.isArray(reply)) throw new Error(`COMMAND failed: ${JSON.stringify(reply)}`);

  return commandTable(reply);
}

// A dedicated object keeps COMMAND off data shards; every build of a server answers it the same, wasm or native.
export function commands(env: Env, flavour: Flavour = "valkey"): Promise<CommandTable> {
  const server = serverOf(flavour);
  const name = server === "valkey" ? "__meta" : `__meta.${server}`;

  return tables.get(server, () => ask(env.SHARD.getByName(name, objectOptions(env))));
}
