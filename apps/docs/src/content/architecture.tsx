import { TreeStructureIcon } from "@phosphor-icons/react";
import { Table } from "../components/blocks";
import { ArchitectureDiagram } from "../components/diagrams/architecture";
import { PART_SECTIONS } from "./architecture-parts";
import { server, source } from "./sources";
import type { Doc } from "./types";

export const architecture: Doc = {
  slug: "architecture",
  title: "Architecture",
  group: "Start here",
  icon: TreeStructureIcon,
  description:
    "A router per connection, shard objects running Valkey with their AOF in SQLite, and memory-only replicas in other regions. What each part owns, and what it costs.",
  keywords: "architecture components router shard replica rewriter catalog watcher pulse pub/sub classes design",
  intro: (
    <>
      <ArchitectureDiagram />
      <p>
        A box is a responsibility. Shards, replicas, the pub/sub shard and the <code>__meta</code> shard all run the
        same Durable Object code under different names. An arrow is a call path, not a statement about which machine
        runs it.
      </p>
    </>
  ),
  sections: [
    {
      id: "where-it-lives",
      title: "Where everything lives",
      content: (
        <>
          <Table
            headers={["Part", "Where", "Holds"]}
            rows={[
              ["Router", "In the Worker, wherever the connection lands", "Per-connection state only"],
              ["Shards", "Durable Objects at the database's regions", "Valkey's data, and its AOF in SQLite"],
              ["Read replicas", "One per shard per replica region", "A copy of one shard, in memory"],
              ["Rewriters", "One per shard, created on its first rewrite", "A copy of the AOF files during a rewrite"],
              ["Pub/sub shard", "One per database", "Every channel of that database; messages aren't stored"],
              ["__meta shard", "One per server flavour", "Nothing; it answers COMMAND for the routers' key tables"],
              ["Catalog", "One object", "Each database's record"],
              ["Watcher", "One per watched database, near its first viewer", "Five minutes of history, in memory"],
              ["Pulse", "One object", "Each router process's open connections, in memory"],
              ["Senders", "One per region, only while test traffic runs", "The traffic's database and deadline"],
              ["Dashboard", "The same Worker, loaded on the first page request", "Nothing"],
            ]}
          />
          <p>
            You don't run a server or a cluster manager. You still own the shard counts, the placement, the password,
            and what your clients do when a shard resets.
          </p>
        </>
      ),
    },
    ...PART_SECTIONS,
    {
      id: "trade-offs",
      title: "What the design buys, and costs",
      content: (
        <Table
          headers={["Choice", "Benefit", "Cost"]}
          rows={[
            [
              "Upstream Valkey in wasm",
              "Most commands run in Valkey's own code",
              "64 MB per shard; memory never shrinks",
            ],
            [
              "AOF in SQLite, appendfsync always",
              "Acknowledged writes survive resets and deploys",
              "Each write waits for a storage commit",
            ],
            ["Group commit", "Under load, one commit carries many writes", "Input waits while two commits run"],
            ["Rewrites in a helper object", "The shard keeps serving during a rewrite", "Files copied both ways"],
            ["Replicas fed by the AOF", "Nearby reads that don't wait for commits", "Stale reads across connections"],
            ["A router per connection", "Stock clients, no cluster support", "An extra hop; cross-slot limits"],
            ["Eight shard classes", "In our tests, 16 shards ran in 16 processes", "More bindings to keep"],
            ["Size and placement fixed at creation", "Routing is computed, with no directory", "No resharding"],
            ["Backpressure on every hop", "Memory stays bounded under any load", "Overload slows clients down"],
          ]}
        />
      ),
    },
  ],
  sources: [
    server("index.ts"),
    server("router/router.ts"),
    server("shard/shard.ts"),
    server("replication/replicator.ts"),
    server("shard/rewriter/rewriter.ts"),
    server("catalog/catalog.ts"),
    server("admin/watcher/watcher.ts"),
    source("AGENTS.md"),
  ],
};
