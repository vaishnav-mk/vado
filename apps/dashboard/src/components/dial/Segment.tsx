import { HIGHLIGHT, replicaColor } from "../../lib/colors";
import { summaryState } from "../../lib/replicas";
import type { Shard } from "../../lib/types";
import { annulus, arcSpan, pt, R_IN, R_OUT } from "./geometry";

export function Segment({
  i,
  n,
  shard,
  level,
  read,
  selected,
  hovered,
  highlighted,
  onHover,
  onToggle,
}: {
  i: number;
  n: number;
  shard: Shard | undefined;
  level: number;
  read: string;
  selected: boolean;
  hovered: boolean;
  highlighted: boolean;
  onHover: (i: number | null) => void;
  onToggle: (i: number) => void;
}) {
  const [a0, a1] = arcSpan(i, n),
    [lx, ly] = pt((R_IN + R_OUT) / 2, (a0 + a1) / 2),
    d = annulus(R_IN, R_OUT, a0, a1);

  const reps = shard?.replicas ?? [];
  // Past 16 shards, one dot per shard for all of its replicas, or 576 dots make a solid ring.
  const dots = n > 16 && reps.length ? [{ region: "all", state: summaryState(reps) }] : reps;

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`Shard ${i}`}
      aria-pressed={selected}
      onMouseEnter={() => onHover(i)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(i)}
      onBlur={() => onHover(null)}
      onClick={() => onToggle(i)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle(i);
        }
      }}
      className="cursor-pointer outline-none"
    >
      <path
        d={d}
        className={`${shard && !shard.ok ? "fill-kumo-danger/30" : "fill-kumo-recessed"} stroke-kumo-base`}
        strokeWidth={2}
      />
      {level > 0 && (
        <path
          d={d}
          style={{ fill: read, fillOpacity: 0.15 + 0.85 * level }}
          className="transition-[fill-opacity] duration-700"
        />
      )}
      {(selected || hovered) && <path d={d} className="fill-none stroke-kumo-brand" strokeWidth={3} />}
      {highlighted && (
        <path
          d={annulus(R_IN - 6, R_OUT + 4, a0, a1)}
          fill="none"
          stroke={HIGHLIGHT}
          strokeWidth={3}
          className="motion-safe:animate-pulse"
        />
      )}
      {n <= 32 && (
        <text
          x={lx}
          y={ly}
          textAnchor="middle"
          dominantBaseline="central"
          className={`pointer-events-none text-[15px] font-semibold ${level > 0.55 ? "fill-white" : "fill-current text-kumo-default"}`}
        >
          {i}
        </text>
      )}
      {dots.map((r, k, all) => {
        const [dx, dy] = pt(R_OUT + 10, a0 + ((k + 0.5) / all.length) * (a1 - a0));

        return (
          <circle
            key={r.region}
            cx={dx}
            cy={dy}
            r={n > 16 ? 2.4 : 3.2}
            style={{ fill: replicaColor(r.state), opacity: r.state === "asleep" ? 0.5 : 1 }}
          />
        );
      })}
    </g>
  );
}
