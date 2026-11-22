// Read replicas: a summary, and a grid with a row per shard and a column per region, each cell colored by
// the replica's state.
import { memo } from "react";
import { Badge, LayerCard, Text, Tooltip } from "@cloudflare/kumo";
import { Legend } from "./Legend";
import { REPLICA, REPLICA_WORDS, replicaColor, replicaWords } from "../lib/colors";
import { SLEEP_NOTE } from "../lib/replicas";
import { ms, num, plural } from "../lib/format";
import { REGION_NAMES, WORLD } from "../lib/places";
import type { LiveState, Replica, ReplicaState } from "../lib/types";

const Cell = memo(function Cell({ shard, r }: { shard: number; r: Replica | undefined }) {
  if (!r) return <span className="block size-4 rounded-sm bg-kumo-recessed" aria-hidden />;
  const where = `${r.regionName || REGION_NAMES[r.region] || r.region}${r.city ? ` (${r.city})` : ""}`;
  const detail = [
    replicaWords(r.state),
    r.state === "ready" && r.lagMs !== null ? `${ms(r.lagMs)} behind` : null,
    r.state === "ready" ? `${num(r.reads)} reads/s` : null,
    r.state === "idle" ? "Will copy again" : null,
    r.error ? r.error : null,
  ].filter(Boolean).join(". ");
  return (
    <Tooltip content={<span><strong>Shard {shard} in {where}</strong><br />{detail}</span>}>
      <button type="button" className="block size-4 rounded-sm outline-offset-1" style={{ background: replicaColor(r.state) }} aria-label={`Shard ${shard} in ${where}: ${detail}`} />
    </Tooltip>
  );
}, (a, b) => a.shard === b.shard && a.r?.state === b.r?.state && a.r?.lagMs === b.r?.lagMs && Math.round(a.r?.reads ?? 0) === Math.round(b.r?.reads ?? 0)
  && a.r?.city === b.r?.city && a.r?.error === b.r?.error);

export function Replicas({ state, reads }: { state: LiveState | null; reads: number }) {
  const shards = state?.shards ?? [];
  const all = shards.flatMap((s) => s.replicas ?? []);
  if (!all.length) return null;
  const present = new Set(all.map((r) => r.region));
  const regions = [...WORLD.filter((r) => present.has(r)), ...[...present].filter((r) => !WORLD.includes(r))];
  const counts = all.reduce<Record<string, number>>((a, r) => ({ ...a, [r.state]: (a[r.state] ?? 0) + 1 }), {});
  const ready = counts.ready ?? 0, served = state?.totals?.replicaReads ?? all.reduce((a, r) => a + (r.reads ?? 0), 0);
  const worst = Math.max(0, ...all.filter((r) => r.state === "ready").map((r) => r.lagMs ?? 0));
  return (
    <LayerCard>
      <LayerCard.Secondary>Read replicas</LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="grid grid-cols-3 gap-3">
            <div><div className="text-xl font-semibold tabular-nums">{ready} of {all.length}</div><Text variant="secondary" size="sm">serving reads</Text></div>
            <div><div className="text-xl font-semibold tabular-nums">{ready ? ms(worst) : "–"}</div><Text variant="secondary" size="sm">behind, at most</Text></div>
            <div><div className="text-xl font-semibold tabular-nums">{reads ? `${Math.min(100, Math.round((100 * served) / reads))}%` : "–"}</div><Text variant="secondary" size="sm">of reads served by replicas</Text></div>
          </div>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(REPLICA_WORDS) as ReplicaState[]).filter((k) => counts[k]).map((k) => (
              <Badge key={k} variant={k === "ready" ? "success" : k === "idle" ? "error" : k === "asleep" ? "neutral" : "warning"} appearance="dot">{counts[k]} {REPLICA_WORDS[k].toLowerCase()}</Badge>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Legend color={REPLICA.ready} label="Ready" />
            <Legend color={REPLICA.copying} label="Copying or catching up" />
            <Legend color={REPLICA.asleep} label="Asleep after 10 minutes without traffic" />
            <Legend color={REPLICA.idle} label="Lost its stream, will retry" />
          </div>
          <Text variant="secondary" size="sm">
            {plural(all.length, "replica")}: a copy of every shard in {plural(regions.length, "region")}. Reads go to the nearest copy; writes go to the shard and are streamed out.
            {counts.asleep ? ` ${SLEEP_NOTE}` : ""}
          </Text>
        </div>
        <div className="max-h-80 overflow-auto lg:max-h-96">
          <table className="border-separate border-spacing-1 text-xs">
            <thead className="sticky top-0 bg-kumo-base">
              <tr>
                <th className="pr-2 text-left font-normal text-kumo-subtle">Shard</th>
                {regions.map((r) => (
                  <th key={r} className="font-normal text-kumo-subtle"><Tooltip content={REGION_NAMES[r] ?? r}><span className="cursor-default uppercase">{r}</span></Tooltip></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shards.map((s) => {
                const by = new Map((s.replicas ?? []).map((r) => [r.region, r]));
                return (
                  <tr key={s.i}>
                    <td className="pr-2 text-kumo-subtle tabular-nums">{s.i}</td>
                    {regions.map((r) => <td key={r}><Cell shard={s.i} r={by.get(r)} /></td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </LayerCard.Primary>
    </LayerCard>
  );
}
