import { useMemo } from "react";
import { LayerCard } from "@cloudflare/kumo";
import { LiveChart, type Series } from "./LiveChart";
import { Legend } from "./Legend";
import { SHARD, traffic } from "../lib/colors";
import { ms, num } from "../lib/format";
import type { Place, Point } from "../lib/types";

const perSecond = (v: number) => `${num(v)}/s`;

export function Throughput({ history, dark }: { history: Point[]; dark: boolean }) {
  const series = useMemo<Series[]>(
    () => [
      { id: "reads", name: "Reads", color: traffic(dark), data: history.map((h) => [h.t, h.reads ?? 0]) },
      { id: "writes", name: "Writes", color: SHARD, data: history.map((h) => [h.t, h.writes ?? 0]) },
    ],
    [history, dark],
  );

  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        Commands per second
        <span className="flex gap-4">
          <Legend color={traffic(dark)} label="Reads" />
          <Legend color={SHARD} label="Writes" />
        </span>
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <LiveChart series={series} dark={dark} minStep={0.1} format={perSecond} empty="Waiting for the first numbers" />
      </LayerCard.Primary>
    </LayerCard>
  );
}

export function ResponseTime({
  history,
  dark,
  watcher,
}: {
  history: Point[];
  dark: boolean;
  watcher: Place | null | undefined;
}) {
  const series = useMemo<Series[]>(
    () => [
      { id: "read", name: "Read", color: traffic(dark), data: history.map((h) => [h.t, h.readMs ?? null]) },
      { id: "write", name: "Write", color: SHARD, data: history.map((h) => [h.t, h.writeMs ?? null]) },
    ],
    [history, dark],
  );

  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        {watcher?.city ? `Response time from ${watcher.city}` : "Response time"}
        <span className="flex gap-4">
          <Legend color={traffic(dark)} label="Read" />
          <Legend color={SHARD} label="Write" />
        </span>
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <LiveChart series={series} dark={dark} unit=" ms" format={ms} empty="Waiting for the first measurement" />
      </LayerCard.Primary>
    </LayerCard>
  );
}
