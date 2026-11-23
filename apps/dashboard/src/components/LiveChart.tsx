// Kumo's lower-level Chart, not TimeseriesChart: that can't turn off ECharts' update animation (every point made
// the lines flicker) and rounds fractional y ticks into repeated labels. Stable series ids let setOption merge.
import { useMemo } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { DefaultLabelFormatterCallbackParams, TooltipComponentFormatterCallbackParams } from "echarts";
import { Chart, ChartPalette, Text } from "@cloudflare/kumo";
import { CHART_HEIGHT, CHART_WINDOW_MS } from "../lib/config";
import { axisLabel, clock, niceAxis } from "../lib/format";

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

export interface Series {
  id: string;
  name: string;
  color: string;
  data: [number, number | null][];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function LiveChart({
  series,
  dark,
  unit = "",
  minStep = 1,
  format,
  height = CHART_HEIGHT,
  empty,
}: {
  series: Series[];
  minStep?: number;
  dark: boolean;
  unit?: string;
  format: (v: number) => string;
  height?: number;
  empty: string;
}) {
  const hasData = series.some((s) => s.data.some(([, v]) => v !== null));

  const options = useMemo(() => {
    const end = Math.max(0, ...series.map((s) => s.data.at(-1)?.[0] ?? 0)) || Date.now();
    const top = Math.max(0, ...series.flatMap((s) => s.data.map(([, v]) => v ?? 0)));
    const { max, step } = niceAxis(top, minStep);
    const text = ChartPalette.text("primary", dark);

    return {
      animation: false,
      grid: { left: 56, right: 16, top: 12, bottom: 28 },
      xAxis: {
        type: "time" as const,
        min: end - CHART_WINDOW_MS,
        max: end,
        splitNumber: 5,
        axisLine: { show: false },
        splitLine: { show: false },
        axisLabel: { color: text, hideOverlap: true, formatter: "{HH}:{mm}" },
      },
      yAxis: {
        type: "value" as const,
        min: 0,
        max,
        interval: step,
        axisLabel: { color: text, formatter: (v: number) => `${axisLabel(v, step)}${unit}` },
        splitLine: {
          lineStyle: { type: "dashed" as const, color: dark ? "rgba(156,163,175,.2)" : "rgba(107,114,128,.2)" },
        },
      },
      tooltip: {
        trigger: "axis" as const,
        backgroundColor: dark ? "#1f1f1f" : "#ffffff",
        borderColor: dark ? "#3f3f46" : "#e5e7eb",
        textStyle: { color: dark ? "#f5f5f5" : "#171717", fontSize: 12 },
        dangerousHtmlFormatter: (params: TooltipComponentFormatterCallbackParams) => {
          // SAFETY: trigger "axis" passes an entry per line series below, with that series' name, color and [time, value | null] point.
          const rows = (Array.isArray(params) ? params : [params]) as (DefaultLabelFormatterCallbackParams & {
            seriesName: string;
            color: string;
            value: [number, number | null];
          })[];

          if (!rows.length) return "";

          return `<div style="margin-bottom:4px;opacity:.7">${esc(clock(rows[0].value[0]))}</div>${rows
            .map(
              (r) =>
                `<div style="display:flex;gap:8px;align-items:center"><span style="width:8px;height:8px;border-radius:9px;background:${r.color}"></span>${esc(r.seriesName)}<b style="margin-left:auto;padding-left:12px">${r.value[1] === null ? "–" : esc(format(r.value[1]))}</b></div>`,
            )
            .join("")}`;
        },
      },
      series: series.map((s) => ({
        id: s.id,
        name: s.name,
        type: "line" as const,
        data: s.data,
        color: s.color,
        showSymbol: false,
        lineStyle: { width: 1.5 },
        emphasis: { disabled: true },
        connectNulls: false,
      })),
    };
  }, [series, dark, unit, minStep, format]);

  return (
    <div className="relative">
      <Chart echarts={echarts} options={options} height={height} isDarkMode={dark} />
      {!hasData && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <Text variant="secondary" size="sm">
            {empty}
          </Text>
        </div>
      )}
    </div>
  );
}
