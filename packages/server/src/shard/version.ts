/** When this code was deployed (its Worker version's timestamp), or 0 if unknown. Routers put theirs in the address
 *  they dial ("router-<ms>:6379"), which also says they understand the restart marker, and primaries in their
 *  replication dial ("repl-<ms>:6379"). */
export const deployedAt = (env: Pick<Env, "VERSION">): number => Date.parse(env.VERSION.timestamp) || 0;

/** What a restarting shard's RPCs throw, before running anything: the router tries again. */
export const RESTARTING = "shard restarting onto newer code";

/** The deploy time in a dial address with this prefix ("router-<ms>", "repl-<ms>"), or null (old code, or none). */
export function dialedFrom(address: string, prefix: "router" | "repl"): number | null {
  const match = new RegExp(`^${prefix}-(\\d+)`).exec(address);

  return match ? Number(match[1]) : null;
}
