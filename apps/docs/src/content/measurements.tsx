import { ChartBarIcon } from "@phosphor-icons/react";
import { Metrics, Note, Table } from "../components/blocks";
import { RESULT_SECTIONS } from "./measurements-results";
import { server, source } from "./sources";
import type { Doc } from "./types";

export const measurements: Doc = {
  slug: "measurements",
  title: "Limits and measurements",
  group: "Run it",
  icon: ChartBarIcon,
  description:
    "What one shard holds, how fast writes and reads went, and the conditions behind each number. Measured on production in November 2026, on one account.",
  keywords:
    "limits measurements benchmarks throughput latency memory 64 MB request size cpu cold start deploy rewrite replicas failure tests",
  intro: (
    <>
      <Metrics
        items={[
          { value: "255-304k", label: "SET/s on 16 shards", note: "Through the router, 8 load generators" },
          { value: "0 missing", label: "After aborting every shard", note: "50,000 acknowledged writes, twice" },
          { value: "10-25 s", label: "To new code after a deploy", note: "With no failed commands" },
        ]}
      />
      <p>
        Most numbers come from the bench API, which runs its clients inside Cloudflare: load generators through the
        router, Sender objects in each of the nine regions, or straight to one shard. Latency over TCP came from one
        laptop on a home connection.
      </p>
    </>
  ),
  sections: [
    {
      id: "limits",
      title: "Limits",
      content: (
        <Table
          headers={["Limit", "Value", "Why"]}
          rows={[
            ["Data per shard", "64 MB", "Valkey's data lives in wasm memory, inside a 128 MB memory limit"],
            ["Request size", "About 8 MB; 64 KB before AUTH", "A shard holds the query, the value and its AOF entry"],
            ["CPU", "One thread per shard; about 30 s per command", "An object kept near 100% CPU is reset"],
            ["Writes per shard", "114-130k SET/s, deep pipelines", "A shard runs on one thread"],
            ["With 9 replicas", "49-61k SET/s per shard", "Replication streams hold back the primary's input"],
            ["Size, regions, replicas", "Fixed at creation", "Routing is computed from the catalog record"],
            ["Replica reads", "Up to one replication lag stale", "Only on other connections"],
          ]}
        />
      ),
    },
    {
      id: "memory",
      title: "Memory",
      content: (
        <>
          <p>
            The 64 MB limit counts Valkey's <code>used_memory</code>. The memory limit counts wasm linear memory, which
            measured 1.08 to 1.29 times <code>used_memory</code> with the build's allocator, flat across rounds of
            deleting and rewriting half the keys.
          </p>
          <p>
            Linear memory never shrinks: after deleting data from 39 MB to 9 MB, it stayed at 44 MB. With{" "}
            <code>noeviction</code>, writes past the limit get <code>OOM</code>; with <code>allkeys-lru</code> the shard
            evicts like a cache.
          </p>
        </>
      ),
    },
    ...RESULT_SECTIONS,
    {
      id: "caveats",
      title: "What these don't show",
      content: (
        <Note>
          <p>
            One account, test traffic only, and runs of minutes, not hours. No eviction under memory pressure, no TLS on
            the TCP path, and no many-client load spread across regions. Latency depends on where each shard lands,
            which varies per object. The allocator runs used one shard and synthetic data; the rewrite times are for one
            base size.
          </p>
        </Note>
      ),
    },
  ],
  sources: [
    server("bench/bench.ts"),
    server("bench/load-tests.ts"),
    server("bench/shard-probes.ts"),
    source("test/hammer.mjs"),
    source("test/deploy.mjs"),
  ],
};
