// Read replicas, a row per region: each region keeps a copy of every shard, so each row is a copy of the whole
// database. The strip has a bar per shard, lined up across regions: its color is that replica's state and its
// height how far behind its shard it is, so a copy far from its shard stands tall and a lagging one stands out;
// a bright cap means it is serving reads. Hover a bar for the details; click it to select that shard (as the
// dial and the table do).
import { useState } from "react";
import { Badge, LayerCard, Text } from "@cloudflare/kumo";
import { Legend } from "./Legend";
import { REPLICA, replicaColor, replicaWords } from "../lib/colors";
import { ms, num, plural } from "../lib/format";
import { REGION_NAMES, WORLD } from "../lib/places";
import { replicaCounts, replicaLine, SLEEP_NOTE } from "../lib/replicas";
import type { LiveState, Replica } from "../lib/types";

interface Row { region: string; name: string; city: string | null; cells: (Replica | undefined)[]; lag: number | null; reads: number; note: string | null }

function rows(state: LiveState | null): Row[] {
  const shards = state?.shards ?? [];
  const present = new Set(shards.flatMap((s) => (s.replicas ?? []).map((r) => r.region)));
  const order = [...WORLD.filter((r) => present.has(r)), ...[...present].filter((r) => !WORLD.includes(r))]; // west to east
  return order.map((region) => {
    const cells = shards.map((s) => s.replicas?.find((r) => r.region === region));
    const here = cells.filter((r): r is Replica => !!r);
    const ready = here.filter((r) => r.state === "ready");
    const cities = new Map<string, number>();
    for (const r of here) if (r.city) cities.set(r.city, (cities.get(r.city) ?? 0) + 1);
    const city = [...cities].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const note = ready.length ? null : here.some((r) => r.state === "idle") ? "Reconnecting" : here.some((r) => r.state === "copying" || r.state === "catching up") ? "Copying" : "Asleep";
    return {
      region, name: here[0]?.regionName || REGION_NAMES[region] || region, city, cells,
      lag: ready.length ? Math.max(...ready.map((r) => r.lagMs ?? 0)) : null, reads: here.reduce((a, r) => a + (r.reads ?? 0), 0), note,
    };
  });
}

/** A bar's height (percent): sleeping copies lie flat, copying ones stand half up, serving ones by their lag. */
function height(r: Replica | undefined, maxLag: number) {
  if (!r) return 0;
  if (r.state === "asleep") return 12;
  if (r.state === "idle") return 100;
  if (r.state !== "ready") return 55;
  return 18 + 82 * Math.min(1, (r.lagMs ?? 0) / maxLag);
}
const SERVING = 0.05; // reads/s above which a replica counts as serving reads right now
// Each row is its own grid with fixed tracks, so strips line up across rows. On a phone the name and numbers
// share a line and the strip gets the full width under them.
const ROW = "grid grid-cols-[minmax(0,1fr)_4rem_4rem] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[13rem_minmax(0,1fr)_4.5rem_4.5rem]";
const STRIP = "col-span-3 row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1";
const LAG = "col-start-2 row-start-1 text-right sm:col-start-3";
const READS = "col-start-3 row-start-1 text-right sm:col-start-4";

export function Replicas({ state, reads, selected, onSelect }: { state: LiveState | null; reads: number; selected: number | null; onSelect: (i: number | null) => void }) {
  const [hover, setHover] = useState<{ shard: number; region: string; x: number; y: number } | null>(null);
  const board = rows(state);
  const counts = replicaCounts(state?.shards);
  if (!counts.total) return null;
  const n = state?.shards?.length ?? 0;
  const maxLag = Math.max(50, ...board.flatMap((r) => r.cells.map((c) => (c?.state === "ready" ? c.lagMs ?? 0 : 0))));
  const served = state?.totals?.replicaReads ?? 0;
  const worst = Math.max(0, ...board.map((r) => r.lag ?? 0));
  const line = replicaLine(counts);
  const tip = hover && (() => {
    const row = board.find((r) => r.region === hover.region), r = row?.cells[hover.shard];
    if (!row || !r) return null;
    const bits = r.state === "asleep" ? ["Asleep: no traffic to this shard for 10 minutes"]
      : [replicaWords(r.state), r.state === "ready" && r.lagMs !== null ? `${ms(r.lagMs)} behind` : null, r.state === "ready" ? `${num(r.reads)} reads/s` : null, r.state === "idle" ? r.error : null].filter(Boolean);
    return { title: `Shard ${hover.shard} in ${row.name}${r.city ? ` (${r.city})` : ""}`, text: bits.join(", ") };
  })();
  const focus = hover?.shard ?? selected;
  const gap = n > 32 ? "gap-px" : n > 8 ? "gap-0.5" : "gap-1";

  return (
    <LayerCard>
      <LayerCard.Secondary>Read replicas</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
          <Figure value={`${counts.ready.toLocaleString("en")} of ${counts.total.toLocaleString("en")}`} label="serving reads" />
          <Figure value={counts.ready ? ms(worst) : "–"} label="behind the shards, at most" />
          <Figure value={reads ? `${Math.min(100, Math.round((100 * served) / reads))}%` : "–"} label="of reads answered by a replica" />
          {counts.ready !== counts.total && <Badge variant={line.variant} appearance="dot" className="mb-1">{line.text}</Badge>}
        </div>

        <div className="relative" onMouseLeave={() => setHover(null)}>
          <div className="flex flex-col gap-2.5">
            <div className={ROW}>
              <span className="text-xs text-kumo-subtle">Region</span>
              <span className={`${STRIP} text-xs text-kumo-subtle`}>{n === 1 ? "Its copy of the shard; taller is further behind" : `A bar per shard, 0 to ${n - 1}; taller is further behind`}</span>
              <span className={`${LAG} text-xs text-kumo-subtle`}>Behind</span>
              <span className={`${READS} text-xs text-kumo-subtle`}>Reads/s</span>
            </div>
            {board.map((row) => (
              <RowView key={row.region} row={row} maxLag={maxLag} gap={gap} focus={focus}
                onHover={(shard, e) => setHover({ shard, region: row.region, x: e.clientX, y: e.clientY })}
                onPick={(shard) => onSelect(selected === shard ? null : shard)} />
            ))}
          </div>
          {tip && hover && (
            <div role="tooltip" className="pointer-events-none fixed z-20 w-60 -translate-x-1/2 -translate-y-full rounded-lg border border-kumo-line bg-kumo-base px-2.5 py-2 text-xs leading-snug shadow-lg"
              style={{ left: hover.x, top: hover.y - 12 }}>
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
            <span className="flex items-center gap-1.5 text-sm text-kumo-subtle"><span className="h-2.5 w-2 rounded-[2px]" style={{ background: REPLICA.ready, boxShadow: "inset 0 2px 0 rgba(255,255,255,.75)" }} />Serving reads now</span>
          </div>
          <Text variant="secondary" size="sm">
            {plural(counts.total, "replica")}: a copy of every shard in {plural(board.length, "region")}. Reads go to the nearest copy; writes go to
            the shard and are streamed out.{counts.asleep ? ` ${SLEEP_NOTE}` : ""}
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
      <Text variant="secondary" size="sm">{label}</Text>
    </div>
  );
}

function RowView({ row, maxLag, gap, focus, onHover, onPick }: {
  row: Row; maxLag: number; gap: string; focus: number | null;
  onHover: (shard: number, e: React.MouseEvent) => void; onPick: (shard: number) => void;
}) {
  const serving = row.cells.filter((c) => c?.state === "ready").length;
  return (
    <div className={ROW}>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-kumo-default">{row.name}</div>
        <div className="truncate text-xs text-kumo-subtle">{row.city ?? "\u00a0"}</div>
      </div>
      <div className={`${STRIP} flex h-9 items-end ${gap}`} role="img"
        aria-label={`${row.name}: ${serving} of ${row.cells.length} serving${row.lag !== null ? `, up to ${ms(row.lag)} behind` : ""}`}>
        {row.cells.map((c, i) => (
          <div key={i} className={`flex h-full max-w-10 flex-1 cursor-pointer items-end rounded-[2px] ${focus === i ? "bg-kumo-brand/15" : ""}`}
            onMouseMove={(e) => onHover(i, e)} onClick={() => onPick(i)}>
            <div className={`w-full rounded-[2px] motion-safe:transition-[height] motion-safe:duration-700 ${c?.state === "copying" || c?.state === "catching up" ? "motion-safe:animate-pulse" : ""}`}
              style={{ height: `${height(c, maxLag)}%`, background: replicaColor(c?.state), opacity: c?.state === "asleep" ? 0.45 : 1,
                boxShadow: (c?.reads ?? 0) > SERVING ? "inset 0 3px 0 rgba(255,255,255,.75)" : undefined }} />
          </div>
        ))}
      </div>
      <div className={`${LAG} text-sm tabular-nums text-kumo-default`}>{row.lag !== null ? ms(row.lag) : <span className="text-kumo-subtle">{row.note}</span>}</div>
      <div className={`${READS} text-sm tabular-nums text-kumo-default`}>{num(row.reads)}</div>
    </div>
  );
}
