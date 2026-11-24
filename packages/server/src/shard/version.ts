// A router dialing "router-<ms>" also says it understands the restart marker.
export const deployedAt = (env: Pick<Env, "VERSION">): number => Date.parse(env.VERSION.timestamp) || 0;

export const RESTARTING = "shard restarting onto newer code";

// The address a router or a primary dials a shard at, and the deploy time it carries.
export const dialAddress = (prefix: "router" | "repl", deployed: number): string => `${prefix}-${deployed}:6379`;

export function dialedFrom(address: string, prefix: "router" | "repl"): number | null {
  const match = new RegExp(`^${prefix}-(\\d+)`).exec(address);

  return match ? Number(match[1]) : null;
}
