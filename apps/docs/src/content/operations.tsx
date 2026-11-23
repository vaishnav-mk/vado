import { WrenchIcon } from "@phosphor-icons/react";
import { Code, Table } from "../components/blocks";
import { DocLink } from "../components/doc-link";
import { BENCH_SECTION } from "./operations-bench";
import { COSTS_SECTION } from "./operations-costs";
import { server, source } from "./sources";
import type { Doc } from "./types";

export const operations: Doc = {
  slug: "operations",
  title: "Operations",
  group: "Run it",
  icon: WrenchIcon,
  description:
    "Deploy, configure, create databases with a placement, watch the dashboard, drive the bench API, know what it costs, and upgrade without breaking running shards.",
  keywords:
    "deploy configure settings secrets env vars VALKEY_MAXMEMORY LOCATION_HINT dashboard bench api token costs pricing billing duration upgrade migrations rollback",
  sections: [
    {
      id: "deploy",
      title: "Deploy",
      content: (
        <>
          <Code label="From a checkout">
            {
              "npx wrangler secret put VALKEY_PASSWORD\nnpx wrangler secret put BENCH_TOKEN      # optional: turns on the bench API\nnpm run deploy\n\nVADO_REDIS=1 npm run deploy              # carry Redis too\nVADO_CONTAINERS=1 npm run deploy         # and the servers in containers (needs Docker)"
            }
          </Code>
          <p>
            Open connections keep the old router code until they end. Busy shards restart onto the new code after they
            drain, and idle ones get it when they next start. Wait a minute after a deploy before measuring anything.
          </p>
        </>
      ),
    },
    {
      id: "settings",
      title: "Settings",
      content: (
        <Table
          headers={["Setting", "Default", "Meaning"]}
          rows={[
            ["VALKEY_PASSWORD (secret)", "unset", "Makes AUTH mandatory and turns on /ws"],
            ["BENCH_TOKEN (secret)", "unset", "Bearer token for the bench API; unset turns it off"],
            ["SHARD_EPOCHS", '[{"from":0,"shards":1}]', "Shard count by creation time. Append, never edit"],
            ["LOCATION_HINT", "unset", "Region for new shards without a regions list, and every pub/sub shard"],
            ["VALKEY_MAXMEMORY", "64mb", "Per shard. Keep it at or under 64 MB: the memory limit is 128 MB"],
            ["VALKEY_MAXMEMORY_POLICY", "noeviction", "allkeys-lru for a cache"],
            ["VALKEY_LOGLEVEL", "warning", "Valkey's log level, written to the Worker's logs"],
            ["ROUTER_IDLE_MS", "30000", "Idle shard sockets close after this"],
            ["ROUTER_SOCKET_BUDGET", "128", "Sockets per process before routers switch to batched calls"],
          ]}
        />
      ),
    },
    {
      id: "create",
      title: "Create a database with a placement",
      content: (
        <>
          <p>
            A database is created on its first AUTH with its name, running Valkey, with no replicas and the current
            epoch's shard count (1 unless you set <code>SHARD_EPOCHS</code>), at <code>LOCATION_HINT</code>. The
            dashboard only watches. To choose the size, placement, replicas or flavour, create the database first
            through the bench API, after setting its token:
          </p>
          <Code label="Bench API">
            {
              'npx wrangler secret put BENCH_TOKEN\ncurl -H "authorization: Bearer $BENCH_TOKEN" \\\n  "https://<your-worker>.workers.dev/db?db=cache&shards=16&flavour=redis"\ncurl -H "authorization: Bearer $BENCH_TOKEN" \\\n  "https://<your-worker>.workers.dev/db?db=mydb&shards=16&regions=world&replicas=world"'
            }
          </Code>
          <p>
            <code>regions</code> and <code>replicas</code> take <code>world</code> or a comma-separated list of hints.{" "}
            <code>flavour</code> is <code>valkey</code>, <code>valkey-native</code>, <code>redis</code> or{" "}
            <code>redis-native</code>, as the build allows (<DocLink slug="flavours">flavours</DocLink>), and{" "}
            <code>password=new</code> gives the database its own password, returned once. For an existing database,{" "}
            <code>/db</code> returns its record unchanged.
          </p>
        </>
      ),
    },
    {
      id: "dashboard",
      title: "Dashboard",
      content: (
        <p>
          The dashboard is the Worker's own URL. It shows each database's shards, its replicas on a globe, where traffic
          enters, response times and a timeline. Live numbers come over <code>/live</code> from the database's Watcher,
          and carry counts, sizes, rates and city names, never keys, values or client addresses.
        </p>
      ),
    },
    BENCH_SECTION,
    COSTS_SECTION,
    {
      id: "upgrading",
      title: "Upgrading safely",
      content: (
        <ul>
          <li>
            During a deploy, old routers call new shards, old primaries stream to new replicas, and old shards send
            rewrites to new rewriters. Keep Durable Object methods and the rewriter's socket protocol stable, and make
            changes additive.
          </li>
          <li>
            Each object's tables come from its <code>migrations.ts</code>. Add a migration; never edit a shipped one or
            rename a table or column.
          </li>
          <li>New Durable Object classes need a new migration tag in the Worker's wrangler.jsonc.</li>
          <li>
            Never remove a shard class, and keep rewriter classes in step with shard classes: class <code>k</code> finds{" "}
            <code>REWRITER{"<k>"}</code> by name.
          </li>
          <li>
            Don't roll back past the change that added shard classes, or the one that stored file rows under keys. Older
            code can't find the shards or read the files written since.
          </li>
          <li>Change capacity by appending an epoch. Existing databases keep their size.</li>
        </ul>
      ),
    },
  ],
  sources: [
    source("wrangler.jsonc"),
    server("env.d.ts"),
    server("admin/admin.ts"),
    server("bench/bench.ts"),
    source("AGENTS.md"),
  ],
};
