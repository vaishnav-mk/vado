import { Badge, Text, Tooltip } from "@cloudflare/kumo";
import { DatabasePicker } from "./DatabasePicker";
import { NewDatabase } from "./NewDatabase";
import { SignIn } from "./SignIn";
import { plural } from "../lib/format";
import { replicaCounts, replicaLine } from "../lib/replicas";
import type { Connection, Database, LiveState, Options } from "../lib/types";

function Health({ state, connection }: { state: LiveState | null; connection: Connection }) {
  if (connection === "retrying")
    return (
      <Tooltip content="The live feed dropped. Reconnecting.">
        <span>
          <Badge variant="warning" appearance="dot">
            Reconnecting
          </Badge>
        </span>
      </Tooltip>
    );

  if (!state)
    return (
      <Badge variant="neutral" appearance="dot">
        Connecting
      </Badge>
    );

  const health = {
    healthy: ["success", "Healthy"],
    restarting: ["warning", `${plural(state.restarting ?? 0, "shard")} restarting`],
    unreachable: ["error", "Not reachable"],
    starting: ["neutral", "Starting"],
  } as const;

  const [variant, label] = health[state.health] ?? health.starting;

  const reps = replicaCounts(state.shards),
    line = replicaLine(reps);

  const total = state.db?.shards ?? state.shards.length,
    up = state.shards.filter((s) => s.ok).length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={variant} appearance="dot">
        {label}
      </Badge>
      {total > 0 && (
        <Badge variant={up === total ? "success" : "warning"} appearance="dot">
          {up === total ? `${plural(total, "shard")} up` : `${up} of ${plural(total, "shard")} up`}
        </Badge>
      )}
      {reps.total > 0 && (
        <Badge variant={line.variant} appearance="dot">
          {line.text}
        </Badge>
      )}
      {state.test && (
        <Badge variant="neutral" appearance="dot">
          Test traffic on
        </Badge>
      )}
    </div>
  );
}

export function Header({
  name,
  databases,
  options,
  state,
  connection,
}: {
  name: string | null;
  databases: Database[];
  options: Options;
  state: LiveState | null;
  connection: Connection;
}) {
  return (
    <header className="border-b border-kumo-hairline bg-kumo-base">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-6 py-3">
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 28 28" className="size-6" fill="none" aria-hidden="true">
            <rect x="3" y="3" width="10" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
            <rect x="15" y="3" width="10" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
            <rect x="3" y="15" width="10" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
            <rect x="15" y="15" width="10" height="10" rx="2.5" className="fill-kumo-brand" />
          </svg>
          <Text variant="heading" as="h1">
            vado
          </Text>
        </div>
        {databases.length > 0 && <DatabasePicker name={name} databases={databases} />}
        <NewDatabase options={options} />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {name && <Health state={state} connection={connection} />}
          <SignIn />
        </div>
      </div>
    </header>
  );
}
