// The shard dial: every key hashes to one of 16,384 slots, and each shard owns one arc of them. Brighter arcs are
// busier; dots fly from the middle into each shard as fast as its traffic; dots outside are its replicas.
import { useRef, useState } from "react";
import { LayerCard, Text } from "@cloudflare/kumo";
import { REPLICA, SHARD, traffic } from "../../lib/colors";
import { bytes, num, plural } from "../../lib/format";
import { useReducedMotion } from "../../lib/hooks";
import type { Shard } from "../../lib/types";
import { Legend } from "../Legend";
import { useTrafficDots } from "./dots";
import { ops, R_HUB } from "./geometry";
import { Segment } from "./Segment";

export function ShardDial({
  shards,
  count,
  total,
  dark,
  selected,
  onSelect,
  highlight,
}: {
  shards: Shard[];
  count: number;
  total: number;
  dark: boolean;
  selected: number | null;
  onSelect: (i: number | null) => void;
  highlight: number | null;
}) {
  const n = Math.max(1, count || shards.length),
    max = Math.max(1, ...shards.map(ops));

  const read = traffic(dark),
    calm = useReducedMotion();

  const level = (s: Shard | undefined) => (s?.ok && ops(s) ? Math.log1p(ops(s)) / Math.log1p(Math.max(max, 500)) : 0);
  const [hover, setHover] = useState<number | null>(null);

  const focus = hover ?? selected,
    f = focus !== null ? shards[focus] : undefined;

  const canvas = useRef<HTMLCanvasElement>(null);

  useTrafficDots(canvas, shards, n, read, calm);

  const toggle = (i: number) => onSelect(selected === i ? null : i);
  const busiest = shards.reduce<Shard | undefined>((b, s) => (ops(s) > ops(b) ? s : b), undefined);
  const hasReplicas = shards.some((s) => s.replicas?.length);

  return (
    <LayerCard className="h-full">
      <LayerCard.Secondary>Shards</LayerCard.Secondary>
      <LayerCard.Primary className="flex-1 items-center gap-3">
        <div className="relative aspect-square w-full max-w-[360px]">
          <svg
            viewBox="0 0 400 400"
            className="absolute inset-0 size-full"
            role="group"
            aria-label={`${plural(n, "shard")}, brighter with more traffic`}
          >
            <circle cx="200" cy="200" r={R_HUB} className="fill-none stroke-kumo-hairline" />
            {Array.from({ length: n }, (_, i) => (
              <Segment
                key={i}
                i={i}
                n={n}
                shard={shards[i]}
                level={level(shards[i])}
                read={read}
                selected={selected === i}
                hovered={hover === i}
                highlighted={highlight === i}
                onHover={setHover}
                onToggle={toggle}
              />
            ))}
          </svg>
          <canvas ref={canvas} className="pointer-events-none absolute inset-0 size-full" aria-hidden />
          <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
            <span className="text-3xl font-semibold tabular-nums">{num(total)}</span>
            <Text variant="secondary" size="sm">
              commands/s
            </Text>
          </div>
        </div>
        <Text variant="secondary" size="sm">
          {f
            ? f.ok
              ? `Shard ${f.i}${f.city ? ` in ${f.city}` : ""}: ${num(ops(f))} commands/s, ${(f.keys ?? 0).toLocaleString("en")} keys, ${bytes(f.memory?.used)}`
              : `Shard ${f.i} isn't responding`
            : focus !== null
              ? `Shard ${focus}: waiting for its numbers`
              : "Each key belongs to one shard. Brighter shards are busier. Select one to find it in the table."}
        </Text>
        <div className="mt-auto flex w-full flex-col gap-3 border-t border-kumo-hairline pt-3">
          {busiest && (
            <div className="flex items-baseline justify-between gap-3">
              <Text variant="secondary" size="sm">
                Busiest right now
              </Text>
              <button
                type="button"
                className="text-right text-sm font-medium tabular-nums hover:underline"
                onClick={() => onSelect(busiest.i)}
              >
                Shard {busiest.i}
                {busiest.city ? ` in ${busiest.city}` : ""}, {num(ops(busiest))}/s
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <Legend color={read} label="Reads" />
            <Legend color={SHARD} label="Writes" />
            {hasReplicas && (
              <>
                <Legend color={REPLICA.ready} label="Replica ready" />
                <Legend color={REPLICA.copying} label="Copying" />
                <Legend color={REPLICA.asleep} label="Asleep" />
                <Legend color={REPLICA.idle} label="Lost its stream" />
              </>
            )}
          </div>
        </div>
      </LayerCard.Primary>
    </LayerCard>
  );
}
