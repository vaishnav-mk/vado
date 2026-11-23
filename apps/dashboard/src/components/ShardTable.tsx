import { useEffect, useRef } from "react";
import { Badge, LayerCard, Meter, RefreshButton, Table, Text, Tooltip } from "@cloudflare/kumo";
import { Guard } from "./Guard";
import { restartShard } from "../server/admin";
import { bytes, bytesOf, duration, ms, num } from "../lib/format";
import { replicaReads } from "../lib/replicas";
import { replicaWords } from "../lib/colors";
import { RESTARTING_MS } from "../lib/config";
import { useAction } from "../lib/hooks";
import type { Replica, Shard } from "../lib/types";

function Status({ s, now }: { s: Shard; now: number }) {
  if (!s.ok)
    return (
      <Tooltip content={s.error || "No answer"}>
        <span>
          <Badge variant="error" appearance="dot">
            Not responding
          </Badge>
        </span>
      </Tooltip>
    );

  if (s.restartedAt && now - s.restartedAt < RESTARTING_MS)
    return (
      <Badge variant="warning" appearance="dot">
        Just restarted
      </Badge>
    );

  if (s.log?.rewriting)
    return (
      <Badge variant="neutral" appearance="dot">
        Compacting its log
      </Badge>
    );

  return (
    <Badge variant="success" appearance="dot">
      Healthy
    </Badge>
  );
}

function replicaLine(replicas: Replica[]) {
  const n = replicas.length,
    ready = replicas.filter((r) => r.state === "ready");

  const worst = Math.max(0, ...ready.map((r) => r.lagMs ?? 0)),
    lag = ready.length ? `, up to ${ms(worst)} behind` : "";

  const same = replicas.every((r) => r.state === replicas[0].state);

  if (same && replicas[0].state !== "ready") return `${n} ${replicaWords(replicas[0].state).toLowerCase()}`;

  return `${ready.length === n ? n : `${ready.length} of ${n}`} ready${lag}`;
}

function Restart({ db, i }: { db: string; i: number }) {
  const { busy, error, run } = useAction();

  return (
    <Guard action="restart a shard">
      {(disabled) => (
        <Tooltip content={error ?? "Restart this shard, as a deploy or crash would. Saved data stays."}>
          {/* RefreshButton doesn't disable itself while loading. */}
          <RefreshButton
            variant="secondary"
            size="sm"
            aria-label={`Restart shard ${i}`}
            loading={busy}
            disabled={disabled || busy}
            className={error ? "text-kumo-danger" : undefined}
            onClick={(e) => {
              e.stopPropagation();
              void run(() => restartShard({ data: { name: db, shard: i } }));
            }}
          />
        </Tooltip>
      )}
    </Guard>
  );
}

export function ShardTable({
  db,
  shards,
  now,
  selected,
  onSelect,
}: {
  db: string;
  shards: Shard[];
  now: number;
  selected: number | null;
  onSelect: (i: number | null) => void;
}) {
  const rows = useRef<Record<number, HTMLTableRowElement | null>>({});
  useEffect(() => {
    if (selected !== null) rows.current[selected]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  const withReplicas = shards.some((s) => s.replicas?.length);

  return (
    <LayerCard>
      <LayerCard.Secondary>Shard details</LayerCard.Secondary>
      <LayerCard.Primary className="max-h-[640px] overflow-auto p-0 [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
        {!shards.length ? (
          <div className="p-6">
            <Text variant="secondary" size="sm">
              Waiting for the first numbers from the shards.
            </Text>
          </div>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Shard</Table.Head>
                <Table.Head>Where</Table.Head>
                <Table.Head>Status</Table.Head>
                <Table.Head className="text-right">Reads/s</Table.Head>
                <Table.Head className="text-right">Writes/s</Table.Head>
                <Table.Head className="text-right">Keys</Table.Head>
                <Table.Head className="min-w-36">Memory</Table.Head>
                <Table.Head className="text-right whitespace-nowrap">Saved log</Table.Head>
                <Table.Head className="text-right whitespace-nowrap">Up for</Table.Head>
                {withReplicas && <Table.Head>Replicas</Table.Head>}
                <Table.Head>
                  <span className="sr-only">Restart</span>
                </Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {shards.map((s) => (
                <Table.Row
                  key={s.i}
                  variant={selected === s.i ? "selected" : "default"}
                  ref={(el: HTMLTableRowElement | null) => {
                    rows.current[s.i] = el;
                  }}
                  onClick={() => onSelect(selected === s.i ? null : s.i)}
                  className="cursor-pointer"
                >
                  <Table.Cell>
                    <Text bold>{s.i}</Text>
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap">{s.city || "–"}</Table.Cell>
                  <Table.Cell>
                    <Status s={s} now={now} />
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums">
                    {s.ok ? num(s.reads + replicaReads(s.replicas)) : "–"}
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums">{s.ok ? num(s.writes) : "–"}</Table.Cell>
                  <Table.Cell className="text-right tabular-nums">
                    {s.ok ? (s.keys ?? 0).toLocaleString("en") : "–"}
                  </Table.Cell>
                  <Table.Cell>
                    {s.ok && (
                      <Meter
                        label={bytesOf(s.memory?.used, s.memory?.max)}
                        value={s.memory?.max ? Math.min(100, (100 * s.memory.used) / s.memory.max) : 0}
                        showValue={false}
                      />
                    )}
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                    {s.ok ? bytes(s.log?.size) : "–"}
                  </Table.Cell>
                  <Table.Cell className="text-right tabular-nums whitespace-nowrap">
                    {s.ok ? duration(s.aliveSeconds ?? 0) : "–"}
                  </Table.Cell>
                  {withReplicas && (
                    <Table.Cell>
                      <Text size="sm">{s.replicas?.length ? replicaLine(s.replicas) : "–"}</Text>
                    </Table.Cell>
                  )}
                  <Table.Cell className="text-right">
                    <Restart db={db} i={s.i} />
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </LayerCard.Primary>
    </LayerCard>
  );
}
