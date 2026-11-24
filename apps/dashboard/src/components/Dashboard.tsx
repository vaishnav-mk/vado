import { useState } from "react";
import { Banner, Grid } from "@cloudflare/kumo";
import { Activity } from "./Activity";
import { ResponseTime, Throughput } from "./Charts";
import { Globe } from "./globe/Globe";
import { Replicas } from "./replicas/Replicas";
import { RunCommand } from "./RunCommand";
import { ShardDial } from "./dial/ShardDial";
import { ShardTable } from "./ShardTable";
import { Stats } from "./Stats";
import { TestTraffic } from "./TestTraffic";
import type { LastCommand, Live } from "../lib/types";

export function Dashboard({
  name,
  live,
  regions,
  dark,
}: {
  name: string;
  live: Live;
  regions: Record<string, string>;
  dark: boolean;
}) {
  const { state, history, events } = live;
  const [selected, setSelected] = useState<number | null>(null);
  const [last, setLast] = useState<LastCommand | null>(null);

  const shards = state?.shards ?? [],
    t = state?.totals;

  const reads = (t?.reads ?? 0) + (t?.replicaReads ?? 0),
    now = state?.at ?? 0;

  return (
    <main className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-6">
      {state?.error && <Banner variant="error" title="Can't reach the database" description={state.error} />}
      <Stats state={state} reads={reads} />
      <Grid variant="1-2" gap="base">
        <ShardDial
          shards={shards}
          count={state?.db?.shards ?? shards.length}
          total={reads + (t?.writes ?? 0)}
          dark={dark}
          selected={selected}
          onSelect={setSelected}
          highlight={last?.shard ?? null}
        />
        <Globe key={name} state={state} last={last} dark={dark} />
      </Grid>
      <Grid variant="2up" gap="base">
        <Throughput history={history} dark={dark} />
        <ResponseTime history={history} dark={dark} watcher={state?.watcher} />
      </Grid>
      <ShardTable db={name} shards={shards} now={now} selected={selected} onSelect={setSelected} />
      <Replicas state={state} reads={reads} selected={selected} onSelect={setSelected} />
      <Grid variant="2up" gap="base">
        <div className="flex min-w-0 flex-col gap-6">
          <RunCommand db={name} shards={shards} last={last} onResult={setLast} />
          <TestTraffic db={name} test={state?.test} now={now} regions={regions} />
        </div>
        <Activity events={events} />
      </Grid>
    </main>
  );
}
