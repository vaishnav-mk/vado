import { Badge, Select, Text, Tooltip } from "@cloudflare/kumo";
import { useNavigate } from "@tanstack/react-router";
import { NewDatabase } from "./NewDatabase";
import { SignIn } from "./SignIn";
import { plural } from "../lib/format";
import type { Connection } from "../lib/live";
import { replicaCounts, replicaLine } from "../lib/replicas";
import type { Database, LiveState } from "../lib/types";

function describe(d: Database) {
  const spread = (d.regions?.length ?? 0) > 1 ? " around the world" : "";
  return `${d.name} · ${d.flavour === "redis" ? "Redis" : "Valkey"} · ${plural(d.shards, "shard")}${spread}${d.replicas?.length ? " · replicas" : ""}`;
}

function Health({ state, connection }: { state: LiveState | null; connection: Connection }) {
  if (connection === "retrying") return <Tooltip content="The live feed dropped. Reconnecting."><span><Badge variant="warning" appearance="dot">Reconnecting</Badge></span></Tooltip>;
  if (!state) return <Badge variant="neutral" appearance="dot">Connecting</Badge>;
  const health = {
    healthy: ["success", "Healthy"],
    restarting: ["warning", `${plural(state.restarting ?? 0, "shard")} restarting`],
    unreachable: ["error", "Not reachable"],
    starting: ["neutral", "Starting"],
  } as const;
  const [variant, label] = health[state.health] ?? health.starting;
  const reps = replicaCounts(state.shards), line = replicaLine(reps);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={variant} appearance="dot">{label}</Badge>
      {reps.total > 0 && <Badge variant={line.variant} appearance="dot">{line.text}</Badge>}
      {state.test && <Badge variant="neutral" appearance="dot">Test traffic on</Badge>}
    </div>
  );
}

export function Header({ name, databases, regions, state, connection }: {
  name: string | null;
  databases: Database[];
  regions: Record<string, string>;
  state: LiveState | null;
  connection: Connection;
}) {
  const navigate = useNavigate();
  const items = Object.fromEntries(databases.map((d) => [d.name, describe(d)]));
  if (name && !items[name]) items[name] = name;
  return (
    <header className="border-b border-kumo-hairline bg-kumo-base">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-6 py-3">
        <Text variant="heading" as="h1">vado</Text>
        {databases.length > 0 && (
          <Select aria-label="Database" placeholder="Pick a database" value={name ?? null} items={items} className="min-w-72"
            onValueChange={(v) => v && navigate({ to: "/db/$name", params: { name: v as string } })} />
        )}
        <NewDatabase regions={regions} />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {name && <Health state={state} connection={connection} />}
          <SignIn />
        </div>
      </div>
    </header>
  );
}
