import type { ReactNode } from "react";
import { Grid, LayerCard, Meter, Text } from "@cloudflare/kumo";
import { bytes, ms, num, plural } from "../lib/format";
import { replicaCounts, replicaLine } from "../lib/replicas";
import { useViewer } from "./Guard";
import type { LiveState } from "../lib/types";

// Titles must fit one line, or the six inner panels stop lining up.
function Stat({
  title,
  value,
  hint,
  children,
}: {
  title: string;
  value: string;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <LayerCard className="h-full">
      <LayerCard.Secondary className="truncate whitespace-nowrap">{title}</LayerCard.Secondary>
      <LayerCard.Primary className="flex-1 gap-1">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {hint && (
          <Text variant="secondary" size="sm">
            {hint}
          </Text>
        )}
        {children}
      </LayerCard.Primary>
    </LayerCard>
  );
}

export function Stats({ state, reads }: { state: LiveState | null; reads: number }) {
  const t = state?.totals,
    waiting = "–",
    writes = t?.writes ?? 0;

  const { signIn } = useViewer();

  const shards = state?.db?.shards ?? state?.shards?.length ?? 0;

  const probe = state?.probe,
    where = state?.watcher?.city;

  // Name what answered the probe's reads, so "from Singapore" isn't read as "served in Singapore".
  const probed = probe && probe.shard !== null ? state?.shards[probe.shard] : undefined,
    copy = probe?.replica ? probed?.replicas.find((r) => r.region === probe.replica) : undefined;

  const target = copy
    ? `the replica in ${copy.city ?? copy.regionName}`
    : probed && `shard ${probed.i}${probed.city ? ` in ${probed.city}` : ""}`;

  const read = `${where ? `From ${where}` : "Reads"}${target ? ` to ${target}` : ""}.`,
    write =
      probe?.writes === false
        ? signIn
          ? "Sign in to time writes."
          : "Writes aren't timed here."
        : `Writes ${ms(probe?.writeMs)}${copy && probed?.city ? `, to ${probed.city}` : ""}.`;

  const reps = replicaCounts(state?.shards);
  const share = reads && t?.replicaReads ? Math.round((100 * t.replicaReads) / reads) : null;

  return (
    <Grid variant="6up" gap="base">
      <Stat
        title="Commands/s"
        value={t ? num(reads + writes) : waiting}
        hint={t ? `${num(reads)} reads, ${num(writes)} writes${state?.test ? ", with test traffic" : ""}` : undefined}
      />
      <Stat
        title="Response time"
        value={ms(probe?.readMs)}
        hint={probe ? `${read} ${write}${probe.failed ? ` ${probe.failed} failed.` : ""}` : undefined}
      />
      <Stat
        title="Keys"
        value={t ? (t.keys ?? 0).toLocaleString("en") : waiting}
        hint={shards ? `Over ${plural(shards, "shard")}` : undefined}
      />
      <Stat title="Memory" value={t ? bytes(t.memory) : waiting}>
        {t && (
          <Meter
            label={`of ${bytes(t.maxMemory)}`}
            value={t.maxMemory ? Math.min(100, (100 * t.memory) / t.maxMemory) : 0}
            showValue={false}
          />
        )}
      </Stat>
      <Stat title="Saved log" value={t ? bytes(t.logBytes) : waiting} hint="Every write, kept to rebuild shards" />
      <Stat
        title="Replicas serving"
        value={t ? (reps.total ? `${reps.ready} of ${reps.total}` : "None") : waiting}
        hint={
          !t
            ? undefined
            : !reps.total
              ? "No read replicas"
              : reps.ready
                ? reps.asleep
                  ? `The other ${reps.asleep.toLocaleString("en")} are asleep (no recent traffic)`
                  : `${share !== null ? `${share}% of reads, ` : ""}up to ${ms(t.replicaLagMs)} behind`
                : reps.asleep === reps.total
                  ? "Asleep: no traffic for 10 minutes"
                  : replicaLine(reps).text
        }
      />
    </Grid>
  );
}
