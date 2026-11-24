import { useState, type FormEvent } from "react";
import { Button, Input, LayerCard, Select, Text } from "@cloudflare/kumo";
import { PlayIcon } from "@phosphor-icons/react";
import { Guard } from "./Guard";
import { runCommand } from "../server/admin";
import { COMMANDS, OTHER, replicationLine, showArgv, showReply, toArgv, type Arg } from "../lib/command";
import { ms } from "../lib/format";
import { useAction } from "../lib/hooks";
import { place } from "@vado/server/admin/views.ts";
import { regionName } from "@vado/server/replication/regions.ts";
import type { LastCommand, Shard } from "../lib/types";
import { messageOf } from "@vado/server/shared.ts";

const ITEMS = Object.fromEntries(Object.keys(COMMANDS).map((c) => [c, c === OTHER ? "Other command" : c]));

function story(r: LastCommand, shards: Shard[]) {
  const entered = place(r.colo).city,
    shard = r.shard !== null ? shards[r.shard] : undefined;

  const target =
    r.shard === null
      ? null
      : r.read && r.replica
        ? `the replica in ${regionName(r.replica)}`
        : shard?.city
          ? `the shard in ${shard.city}`
          : `shard ${r.shard}`;

  const out = [
    `Took ${ms(r.ms)}${entered && target ? `, from ${entered} to ${target}` : target ? `, at ${target}` : entered ? `, from ${entered}` : ""}.`,
  ];

  out.push(
    r.shard !== null
      ? `Key ${JSON.stringify(r.key)} is in hash slot ${r.slot?.toLocaleString("en")}, which belongs to shard ${r.shard}.`
      : "It has no key, so it isn't tied to one shard.",
  );
  const rep = r.replication;

  if (rep) out.push(replicationLine(rep, r.before));

  return out.join(" ");
}

export function RunCommand({
  db,
  shards,
  last,
  onResult,
}: {
  db: string;
  shards: Shard[];
  last: LastCommand | null;
  onResult: (r: LastCommand) => void;
}) {
  const [cmd, setCmd] = useState<keyof typeof COMMANDS>("GET"),
    [values, setValues] = useState<string[]>([]);

  const { busy, error, setError, run } = useAction();
  const args: Arg[] = COMMANDS[cmd];

  let argv: string[] = [],
    parseError: string | null = null;

  try {
    argv = toArgv(cmd, values);
  } catch (e) {
    parseError = messageOf(e);
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();

    if (parseError || !argv.length) return;
    void run(async () => {
      const before = shards.map((s) => s.replicas?.map((x) => x.state) ?? null);
      const r = await runCommand({ data: { name: db, argv } });
      onResult({ ...r, argv, at: Date.now(), before: r.shard !== null ? (before[r.shard] ?? null) : null });
    });
  };

  return (
    <LayerCard>
      <LayerCard.Secondary>Run a command</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-3">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Select
            label="Command"
            className="w-full"
            value={cmd}
            items={ITEMS}
            onValueChange={(v) => {
              if (v) {
                setCmd(v);
                setValues([]);
                setError(null);
              }
            }}
          />
          {args.map((a, k) => (
            <Input
              key={`${cmd}-${k}`}
              label={a.name}
              placeholder={a.placeholder}
              value={values[k] ?? ""}
              className="w-full font-mono"
              autoComplete="off"
              spellCheck={false}
              description={a.many ? 'Separate values with spaces. "Quote" a value that has spaces.' : undefined}
              onChange={(e) => {
                const next = [...values];
                next[k] = e.target.value;
                setValues(next);
              }}
            />
          ))}
          <div className="flex items-center gap-2">
            <code
              className="flex h-9 min-w-0 flex-1 items-center rounded-lg border border-kumo-line bg-kumo-recessed px-3 font-mono text-xs text-kumo-subtle"
              title={showArgv(argv)}
            >
              <span className="truncate">{parseError ?? (argv.length ? showArgv(argv) : "Type a command")}</span>
            </code>
            <Guard action="run commands">
              {(disabled) => (
                <Button
                  type="submit"
                  variant="primary"
                  icon={PlayIcon}
                  loading={busy}
                  disabled={disabled || !!parseError || !argv.length}
                >
                  Run
                </Button>
              )}
            </Guard>
          </div>
        </form>
        {error && (
          <Text variant="error" size="sm">
            {error}
          </Text>
        )}
        {last && !error && (
          <div className="flex flex-col gap-2">
            <pre className="max-h-96 overflow-auto rounded-md bg-kumo-recessed p-3 font-mono text-sm break-words whitespace-pre-wrap">
              <span className="text-kumo-subtle">{`> ${showArgv(last.argv)}\n`}</span>
              {showReply(last.reply)}
            </pre>
            <Text variant="secondary" size="sm">
              {story(last, shards)}
            </Text>
          </div>
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}
