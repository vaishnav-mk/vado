import { WrenchIcon } from "@phosphor-icons/react";
import { Code, Table } from "../components/blocks";
import { DocLink } from "../components/doc-link";
import { BENCH_SECTION } from "./operations-bench";
import { server, source } from "./sources";
import type { Doc } from "./types";

export const operations: Doc = {
  slug: "operations",
  title: "Operations",
  group: "Run it",
  icon: WrenchIcon,
  description:
    "Deploy, configure, create databases with a placement, sign in to the dashboard, drive the bench API, and upgrade without breaking running shards.",
  keywords:
    "deploy configure settings secrets env vars VALKEY_MAXMEMORY LOCATION_HINT dashboard access sign in bench api token upgrade migrations rollback",
  sections: [
    {
      id: "deploy",
      title: "Deploy",
      content: (
        <>
          <Code label="From a checkout">
            {
              "npx wrangler secret put VALKEY_PASSWORD\nnpx wrangler secret put BENCH_TOKEN      # optional: turns on the bench API\nnpm run deploy -- --var ACCESS_TEAM_DOMAIN:https://<team>.cloudflareaccess.com --var ACCESS_AUD:<tag>\n\nVADO_REDIS=1 npm run deploy              # carry the Redis flavour too"
            }
          </Code>
          <p>
            Open connections keep the old router code until they end. Busy shards restart onto the new code within about
            30 s without failing commands, and idle ones get it when they next start. Wait a minute after a deploy
            before measuring anything.
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
            ["ACCESS_TEAM_DOMAIN, ACCESS_AUD", "required", "Dashboard sign-in with Cloudflare Access"],
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
            Databases are created on first use with the current epoch's shard count, at <code>LOCATION_HINT</code>. To
            choose the size, placement, replicas or flavour, create it first, through the bench API or the dashboard's
            New database dialog:
          </p>
          <Code label="Bench API">
            {
              'curl -H "authorization: Bearer $TOKEN" \\\n  "https://<your-worker>.workers.dev/db?db=mydb&shards=16&regions=world&replicas=world"'
            }
          </Code>
          <p>
            <code>regions</code> and <code>replicas</code> take <code>world</code> or a comma-separated list of hints.{" "}
            <code>flavour=redis</code> runs Redis, and <code>password=new</code> gives the database its own password,
            returned once. For an existing database, <code>/db</code> returns its record unchanged.
          </p>
        </>
      ),
    },
    {
      id: "dashboard",
      title: "Dashboard sign-in",
      content: (
        <>
          <p>
            The dashboard is the Worker's own URL. Anyone can watch: live numbers come over <code>/live</code> from the
            database's Watcher, and carry counts, sizes, rates and city names, never keys, values or client addresses.
          </p>
          <p>
            Changes need signing in through the Access application on <code>/signin</code> (
            <DocLink slug="quick-start" hash="sign-in">
              setup
            </DocLink>
            ). Every change verifies the Access token against the team's signing keys, <code>ACCESS_TEAM_DOMAIN</code>{" "}
            as issuer and <code>ACCESS_AUD</code> as audience, before it runs. Signed in, you can create databases, run
            a command and see which shard and replica answered, restart a shard, and start test traffic, which stops by
            itself after 10 minutes. The dashboard refuses KEYS, FLUSHALL and FLUSHDB; those belong in a client.
          </p>
        </>
      ),
    },
    BENCH_SECTION,
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
    server("admin/access.ts"),
    server("admin/admin.ts"),
    server("bench/bench.ts"),
    source("AGENTS.md"),
  ],
};
