// The timeline: what happened to the shards and replicas, and what was done from this page.
import { useState } from "react";
import { Badge, Empty, LayerCard, Tabs, Text, Tooltip } from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon, BroomIcon, ClockCounterClockwiseIcon, CopyIcon, CursorClickIcon, FlaskIcon, GaugeIcon, RocketLaunchIcon,
  type Icon,
} from "@phosphor-icons/react";
import { ago, dateTime } from "../lib/format";
import { useNow } from "../lib/hooks";
import type { EventKind, EventLevel, LiveEvent } from "../lib/types";

const ICON: Record<EventKind, Icon> = {
  action: CursorClickIcon, test: FlaskIcon, deploy: RocketLaunchIcon, restart: ArrowClockwiseIcon,
  replica: CopyIcon, rewrite: BroomIcon, memory: GaugeIcon,
};
const TONE: Record<EventLevel, string> = {
  info: "bg-kumo-recessed text-kumo-subtle",
  success: "bg-kumo-success/15 text-kumo-success",
  warning: "bg-kumo-warning/15 text-kumo-warning",
  error: "bg-kumo-danger/15 text-kumo-danger",
};

const FILTERS = [
  { value: "all", label: "All", keep: () => true, empty: "Restarts, deploys, replicas and what you do here show up as they happen." },
  { value: "shards", label: "Shards", keep: (e: LiveEvent) => ["restart", "deploy", "rewrite", "memory"].includes(e.kind), empty: "Restarts, deploys and log compactions show up here." },
  { value: "replicas", label: "Replicas", keep: (e: LiveEvent) => e.kind === "replica", empty: "Replicas waking, copying, catching up or going to sleep show up here." },
  { value: "mine", label: "Your actions", keep: (e: LiveEvent) => e.kind === "action" || e.kind === "test", empty: "New databases, restarts and test traffic started from here show up here." },
];

export function Activity({ events }: { events: LiveEvent[] }) {
  const [tab, setTab] = useState("all");
  const now = useNow(5_000);
  const f = FILTERS.find((x) => x.value === tab) ?? FILTERS[0], shown = events.filter(f.keep);
  return (
    <LayerCard className="h-full min-w-0">
      <LayerCard.Secondary>Activity</LayerCard.Secondary>
      <LayerCard.Primary className="min-h-0 flex-1 gap-3">
        <Tabs variant="segmented" size="sm" value={tab} onValueChange={setTab} tabs={FILTERS.map(({ value, label }) => ({ value, label }))} />
        {/* As tall as the cards beside it: the list scrolls rather than stretching the row. */}
        <div className="relative min-h-80 flex-1">
          {shown.length ? (
            <ol className="absolute inset-0 flex flex-col overflow-auto">
              {shown.map((e, k) => {
                const Glyph = ICON[e.kind] ?? ClockCounterClockwiseIcon;
                return (
                  <li key={e.id} className="relative flex gap-3 pb-3">
                    {k < shown.length - 1 && <span className="absolute top-7 bottom-0 left-3.5 w-px bg-kumo-hairline" aria-hidden />}
                    <span className={`grid size-7 shrink-0 place-items-center rounded-full ${TONE[e.level] ?? TONE.info}`}><Glyph size={15} weight="bold" aria-hidden /></span>
                    <div className="flex min-w-0 flex-1 flex-col pt-0.5">
                      <div className="flex items-start gap-2">
                        <Text size="sm">{e.text}</Text>
                        {e.count > 1 && <Badge variant="neutral">×{e.count}</Badge>}
                      </div>
                      <Tooltip content={dateTime(e.t)} side="bottom" align="start">
                        <span className="w-fit cursor-default text-xs text-kumo-subtle">{ago(e.t, Math.max(now, e.t))}</span>
                      </Tooltip>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <Empty size="sm" icon={<ClockCounterClockwiseIcon size={28} />} title="Nothing yet" description={f.empty} />
          )}
        </div>
      </LayerCard.Primary>
    </LayerCard>
  );
}
