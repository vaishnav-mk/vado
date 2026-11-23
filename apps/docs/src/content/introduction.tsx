import { BookOpenIcon } from "@phosphor-icons/react";
import { CardLinks, Code } from "../components/blocks";
import { ArchitectureDiagram } from "../components/diagrams/architecture";
import { DocLink } from "../components/doc-link";
import { ByServer, ServerBadge, ServerName } from "../components/server";
import { SERVERS } from "./servers";
import { source } from "./sources";
import type { Doc } from "./types";

export const introduction: Doc = {
  slug: "introduction",
  title: "Valkey or Redis, made of Durable Objects.",
  navTitle: "Introduction",
  group: "Start here",
  icon: BookOpenIcon,
  description:
    "vado runs upstream Valkey, or Redis if you opt in, compiled to WebAssembly with the fewest changes that let it run in Cloudflare Durable Objects. Each shard keeps its append-only file in SQLite and can stream it to replicas; a router in a Worker spreads keys over the shards. An experiment, not a product.",
  keywords: "overview what is vado valkey redis durable objects wasm introduction",
  intro: (
    <>
      <p>
        Each shard is a Durable Object running the upstream <ServerName /> server, version{" "}
        <ByServer valkey={SERVERS.valkey.version} redis={SERVERS.redis.version} />, with the fewest changes that let it
        run on Workers, and its append-only file (AOF) in the object's SQLite. The router hashes each key to a slot,
        sends the command to the shard that owns it, and can read from replicas in other regions.
      </p>
      <p>vado is an independent experiment, not a product. Don't keep data in it that you can't lose.</p>
      <ArchitectureDiagram />
    </>
  ),
  sections: [
    {
      id: "what-you-get",
      title: "What you get",
      content: (
        <ul>
          <li>
            <strong>
              <ServerName />
              's own code.
            </strong>{" "}
            Most commands run in <ServerName /> itself. The router answers connection, cross-shard and admin commands
            itself (
            <DocLink slug="sharding" hash="differences">
              differences
            </DocLink>
            ). Clients connect over TCP, a WebSocket or a service binding.
          </li>
          <li>
            <strong>Durable writes.</strong> A reply leaves only after its AOF entry is committed to SQLite.
          </li>
          <li>
            <strong>Placement you choose.</strong> Shards in the regions you pick, and read replicas in others if you
            want them. After a write, that connection reads the shard from its primary for 2 s, and <code>WAIT</code>{" "}
            counts the replicas that have the write.
          </li>
          <li>
            <strong>Restarts onto new code.</strong> After a deploy, busy shards answer what they have read, then
            restart.
          </li>
          <li>
            <strong>A password per database</strong>, and databases that can be dropped for good.
          </li>
          <li>
            <strong>A live dashboard</strong> at the Worker's URL: shards, replicas on a globe, where traffic enters,
            response times and a timeline.
          </li>
        </ul>
      ),
    },
    {
      id: "a-first-command",
      title: "A first command",
      content: (
        <>
          <p>
            The AUTH username picks the database. A database is created on its first AUTH, with 1 shard, Valkey and no
            replicas. From a checkout, after <code>npm install</code>, the WebSocket shim gives any client a local TCP
            port. It needs Node 22 or newer:
          </p>
          <Code label="Terminal">
            {
              'node packages/client/ws-shim.mjs wss://<your-worker>.workers.dev/ws 6379\nvalkey-cli -p 6379 --user mydb --pass "$VALKEY_PASSWORD"\n127.0.0.1:6379> SET greeting hello\nOK'
            }
          </Code>
          <p>
            <ServerBadge /> In a <ServerName /> database, <code>INFO server</code> shows{" "}
            <code>
              <ByServer valkey={SERVERS.valkey.info} redis={SERVERS.redis.info} />
            </code>
            .
          </p>
          <p>
            <DocLink slug="quick-start">Quick start</DocLink> covers deploying, TCP through Spectrum, and ioredis from
            another Worker.
          </p>
        </>
      ),
    },
    {
      id: "dashboard",
      title: "The dashboard",
      content: (
        <>
          <img
            className="shot"
            src="/dashboard.jpg"
            width={1600}
            height={1111}
            loading="lazy"
            alt="The dashboard watching a 64-shard database with a read replica of every shard in every region"
          />
          <p className="note">A 64-shard database with a replica of every shard in every region.</p>
        </>
      ),
    },
    {
      id: "read-on",
      title: "Read on",
      content: (
        <CardLinks
          items={[
            { slug: "quick-start", title: "Deploy it", text: "One button and a password, then connect a client." },
            {
              slug: "architecture",
              title: "See every part",
              text: "Router, shards, replicas, rewriters, catalog and the Watcher.",
            },
            {
              slug: "durability",
              title: "How writes survive",
              text: "Write-through storage, group commit, rewrites and restarts.",
            },
            {
              slug: "measurements",
              title: "Limits and numbers",
              text: "What a shard holds, how fast it goes, and under which conditions.",
            },
          ]}
        />
      ),
    },
  ],
  sources: [source("README.md"), source("apps/dashboard/src/server.ts")],
};
