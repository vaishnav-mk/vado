import { useState } from "react";
import { Badge, LayerCard, Text } from "@cloudflare/kumo";
import { REPLICA, replicaWords } from "../../lib/colors";
import { ms, num, plural, share } from "../../lib/format";
import { IDLE_MINUTES, replicaCounts, replicaLine } from "../../lib/replicas";
import type { LiveState } from "../../lib/types";
import { Legend } from "../Legend";
import { LAG, READS, ROW, STRIP } from "./layout";
import { ReplicaRow } from "./ReplicaRow";
import { rows } from "./rows";

const SLEEP_NOTE = `A shard's replicas sleep after ${IDLE_MINUTES} without traffic to that shard, and its next read or write wakes them in a few seconds.`;

export function Replicas({
  state,
  reads,
  selected,
  onSelect,
}: {
  state: LiveState | null;
  reads: number;
  selected: number | null;
  onSelect: (i: number | null) => void;
}) {
  const [hover, setHover] = useState<{ shard: number; region: string; x: number; y: number } | null>(null);
  const board = rows(state);
  const counts = replicaCounts(state?.shards);

  if (!counts.total) return null;
  const n = state?.shards.length ?? 0;

  const worst = state?.totals.replicaLagMs ?? 0,
    maxLag = Math.max(50, worst);

  const served = state?.totals.replicaReads ?? 0;
  const line = replicaLine(counts);

  const tip =
    hover &&
    (() => {
      const row = board.find((r) => r.region === hover.region),
        r = row?.cells[hover.shard];

      if (!row || !r) return null;

      const bits =
        r.state === "asleep"
          ? [`Asleep: no traffic to this shard for ${IDLE_MINUTES}`]
          : [
              replicaWords(r.state),
              r.state === "ready" && r.lagMs !== null ? `${ms(r.lagMs)} behind` : null,
              r.state === "ready" ? `${num(r.reads)} reads/s` : null,
              r.state === "idle" ? r.error : null,
            ].filter(Boolean);

      return { title: `Shard ${hover.shard} in ${row.name}${r.city ? ` (${r.city})` : ""}`, text: bits.join(", ") };
    })();

  const focus = hover?.shard ?? selected;
  const gap = n > 32 ? "gap-px" : n > 8 ? "gap-0.5" : "gap-1";

  return (
    <LayerCard>
      <LayerCard.Secondary>Read replicas</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
          <Figure
            value={`${counts.ready.toLocaleString("en")} of ${counts.total.toLocaleString("en")}`}
            label="serving reads"
          />
          <Figure value={counts.ready ? ms(worst) : "–"} label="behind the shards, at most" />
          <Figure
            value={reads ? `${Math.round(share(served, reads) ?? 0)}%` : "–"}
            label="of reads answered by a replica"
          />
          {counts.ready !== counts.total && (
            <Badge variant={line.variant} appearance="dot" className="mb-1">
              {line.text}
            </Badge>
          )}
        </div>

        <div className="relative" onMouseLeave={() => setHover(null)}>
          <div className="flex flex-col gap-2.5">
            <div className={ROW}>
              <span className="text-xs text-kumo-subtle">Region</span>
              <span className={`${STRIP} text-xs text-kumo-subtle`}>
                {n === 1
                  ? "Its copy of the shard; taller is further behind"
                  : `A bar per shard, 0 to ${n - 1}; taller is further behind`}
              </span>
              <span className={`${LAG} text-xs text-kumo-subtle`}>Behind</span>
              <span className={`${READS} text-xs text-kumo-subtle`}>Reads/s</span>
            </div>
            {board.map((row) => (
              <ReplicaRow
                key={row.region}
                row={row}
                maxLag={maxLag}
                gap={gap}
                focus={focus}
                onHover={(shard, e) => setHover({ shard, region: row.region, x: e.clientX, y: e.clientY })}
                onPick={(shard) => onSelect(selected === shard ? null : shard)}
              />
            ))}
          </div>
          {tip && hover && (
            <div
              role="tooltip"
              className="pointer-events-none fixed z-20 w-60 -translate-x-1/2 -translate-y-full rounded-lg border border-kumo-line bg-kumo-base px-2.5 py-2 text-xs leading-snug shadow-lg"
              style={{ left: hover.x, top: hover.y - 12 }}
            >
              <strong className="block text-kumo-default">{tip.title}</strong>
              <span className="text-kumo-subtle">{tip.text}</span>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-kumo-hairline pt-4">
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <Legend color={REPLICA.ready} label="Ready" />
            <Legend color={REPLICA.copying} label="Copying its shard" />
            <Legend color={REPLICA.asleep} label="Asleep" />
            <Legend color={REPLICA.idle} label="Lost its stream, reconnecting" />
            <span className="flex items-center gap-1.5 text-sm text-kumo-subtle">
              <span
                className="h-2.5 w-2 rounded-[2px]"
                style={{ background: REPLICA.ready, boxShadow: "inset 0 2px 0 rgba(255,255,255,.75)" }}
              />
              Serving reads now
            </span>
          </div>
          <Text variant="secondary" size="sm">
            {plural(counts.total, "replica")}: a copy of every shard in {plural(board.length, "region")}. Reads go to
            the nearest copy; writes go to the shard and are streamed out.{counts.asleep ? ` ${SLEEP_NOTE}` : ""}
          </Text>
        </div>
      </LayerCard.Primary>
    </LayerCard>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <Text variant="secondary" size="sm">
        {label}
      </Text>
    </div>
  );
}
