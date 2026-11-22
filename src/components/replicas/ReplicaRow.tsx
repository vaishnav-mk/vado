import { Tooltip } from "@cloudflare/kumo";
import { HOSTED_ELSEWHERE } from "@vado/server/replication/regions.ts";
import { replicaColor } from "../../lib/colors";
import { SERVING_READS } from "../../lib/config";
import { ms, num } from "../../lib/format";
import { LAG, READS, ROW, STRIP } from "./layout";
import { height } from "./rows";
import type { Row } from "./types";

export function ReplicaRow({
  row,
  maxLag,
  gap,
  focus,
  onHover,
  onPick,
}: {
  row: Row;
  maxLag: number;
  gap: string;
  focus: number | null;
  onHover: (shard: number, e: React.MouseEvent) => void;
  onPick: (shard: number) => void;
}) {
  const serving = row.cells.filter((c) => c?.state === "ready").length;

  return (
    <div className={ROW}>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-kumo-default">{row.name}</div>
        {HOSTED_ELSEWHERE.has(row.region) ? (
          <Tooltip
            content={`Cloudflare doesn't run Durable Objects in ${row.name} yet, so these copies run in the nearest region that has them.`}
          >
            <div className="cursor-help truncate text-xs text-kumo-subtle underline decoration-dotted underline-offset-2">
              {row.city ? `runs in ${row.city}` : "runs nearby"}
            </div>
          </Tooltip>
        ) : (
          <div className="truncate text-xs text-kumo-subtle">{row.city ?? "\u00a0"}</div>
        )}
      </div>
      <div
        className={`${STRIP} flex h-9 items-end ${gap}`}
        role="img"
        aria-label={`${row.name}: ${serving} of ${row.cells.length} serving${row.lag !== null ? `, up to ${ms(row.lag)} behind` : ""}`}
      >
        {row.cells.map((c, i) => (
          <div
            key={i}
            className={`flex h-full max-w-10 flex-1 cursor-pointer items-end rounded-[2px] ${focus === i ? "bg-kumo-brand/15" : ""}`}
            onMouseMove={(e) => onHover(i, e)}
            onClick={() => onPick(i)}
          >
            <div
              className={`w-full rounded-[2px] motion-safe:transition-[height] motion-safe:duration-700 ${c?.state === "copying" || c?.state === "catching up" ? "motion-safe:animate-pulse" : ""}`}
              style={{
                height: `${height(c, maxLag)}%`,
                background: replicaColor(c?.state ?? "asleep"),
                opacity: c?.state === "asleep" ? 0.45 : 1,
                boxShadow: (c?.reads ?? 0) > SERVING_READS ? "inset 0 3px 0 rgba(255,255,255,.75)" : undefined,
              }}
            />
          </div>
        ))}
      </div>
      <div className={`${LAG} text-sm tabular-nums text-kumo-default`}>
        {row.lag !== null ? ms(row.lag) : <span className="text-kumo-subtle">{row.note}</span>}
      </div>
      <div className={`${READS} text-sm tabular-nums text-kumo-default`}>{num(row.reads)}</div>
    </div>
  );
}
