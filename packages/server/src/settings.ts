import type { DurableMigrations } from "@durability/storage";
import { command, isError, str } from "./protocol/resp";
import type { CommandArg } from "./protocol/types";
import { CONFIG_SET } from "./router/command-sets";
import { messageOf } from "./shared";

// Neither the AOF nor the replication stream carries CONFIG SET, so a shard stores what its server accepted and sets it
// again at boot. A setting a later server refuses is logged, not fatal.
export const settingsMigrations = [
  {
    name: "settings_0001_table",
    up: "CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
    down: "SELECT 1;",
  },
] satisfies DurableMigrations;

const argText = (a: CommandArg | undefined) => (a instanceof Uint8Array ? str(a) : String(a ?? ""));

// The router sends CONFIG SET to every shard alone in its batch (router/fanout.ts).
export function keepSettings(sql: SqlStorage, cmds: CommandArg[][], reply: Uint8Array): void {
  const [c = []] = cmds;

  if (cmds.length !== 1 || c.length < 4 || c.length % 2 || str(reply) !== "+OK\r\n") return;

  if (argText(c[0]).toLowerCase() !== "config" || argText(c[1]).toLowerCase() !== "set") return;

  for (let i = 2; i < c.length; i += 2) {
    const k = argText(c[i]).toLowerCase();

    if (CONFIG_SET.has(k)) sql.exec("INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)", k, argText(c[i + 1]));
  }
}

export async function reapply(sql: SqlStorage, exec: (bytes: Uint8Array) => Promise<Uint8Array>): Promise<void> {
  const rows = sql.exec<{ k: string; v: string }>("SELECT k, v FROM settings").toArray();

  if (!rows.length) return;

  const reply = await exec(command(["CONFIG", "SET", ...rows.flatMap((r) => [r.k, r.v])])).catch(messageOf);

  if (!(reply instanceof Uint8Array) || isError(reply)) console.log(`settings: ${argText(reply).trim()}`);
}
