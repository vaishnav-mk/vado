import { useMemo, type ComponentProps } from "react";
import { LayerCard } from "@cloudflare/kumo";
import { LiveChart, type Series } from "./LiveChart";
import { Legend } from "./Legend";
import { SHARD, traffic } from "../lib/colors";
import { ms, num } from "../lib/format";
import type { Place, Point } from "../lib/types";

const perSecond = (v: number) => `${num(v)}/s`;

function ChartCard({ title, ...chart }: ComponentProps<typeof LiveChart> & { title: string }) {
  return (
    <LayerCard>
      <LayerCard.Secondary className="flex items-center justify-between gap-3">
        {title}
        <span className="flex gap-4">
          {chart.series.map((s) => (
            <Legend key={s.id} color={s.color} label={s.name} />
          ))}
        </span>
      </LayerCard.Secondary>
      <LayerCard.Primary>
        <LiveChart {...chart} />
      </LayerCard.Primary>
    </LayerCard>
  );
}

export function Throughput({ history, dark }: { history: Point[]; dark: boolean }) {
  const series = useMemo<Series[]>(
    () => [
      { id: "reads", name: "Reads", color: traffic(dark), data: history.map((h) => [h.t, h.reads]) },
      { id: "writes", name: "Writes", color: SHARD, data: history.map((h) => [h.t, h.writes]) },
    ],
    [history, dark],
  );

  return (
    <ChartCard
      title="Commands per second"
      series={series}
      dark={dark}
      minStep={0.1}
      format={perSecond}
      empty="Waiting for the first numbers"
    />
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
      { id: "read", name: "Read", color: traffic(dark), data: history.map((h) => [h.t, h.readMs]) },
      { id: "write", name: "Write", color: SHARD, data: history.map((h) => [h.t, h.writeMs]) },
    ],
    [history, dark],
  );

  return (
    <ChartCard
      title={watcher?.city ? `Response time from ${watcher.city}` : "Response time"}
      series={series}
      dark={dark}
      unit=" ms"
      format={ms}
      empty="Waiting for the first measurement"
    />
  );
}
