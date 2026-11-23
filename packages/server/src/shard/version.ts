// A router dialing "router-<ms>" also says it understands the restart marker.
export const deployedAt = (env: Pick<Env, "VERSION">): number => Date.parse(env.VERSION.timestamp) || 0;

export const RESTARTING = "shard restarting onto newer code";

export function dialedFrom(address: string, prefix: "router" | "repl"): number | null {
  const match = new RegExp(`^${prefix}-(\\d+)`).exec(address);

  return match ? Number(match[1]) : null;
}
