import { BookOpenIcon } from "@phosphor-icons/react";
import { CardLinks, Code } from "../components/blocks";
import { ArchitectureDiagram } from "../components/diagrams/architecture";
import { DocLink } from "../components/doc-link";
import { source } from "./sources";
import type { Doc } from "./types";

export const introduction: Doc = {
  slug: "introduction",
  title: "One Valkey server, made of Durable Objects.",
  navTitle: "Introduction",
  group: "Start here",
  icon: BookOpenIcon,
  description:
    "vado runs real Valkey 9.1, compiled to WebAssembly, in Cloudflare Durable Objects. A router in a Worker spreads keys over the shards, so valkey-cli and ioredis see one ordinary server.",
  keywords: "overview what is vado valkey redis durable objects wasm introduction",
  intro: (
    <>
      <p>
        Each shard is a Durable Object running the Valkey server itself, with its append-only file (AOF) in the object's
        SQLite. <strong>Clients see one server.</strong> The router hashes each key to a slot, sends the command to the
        shard that owns it, and can read from replicas in other regions.
      </p>
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
            <strong>Valkey's own behaviour.</strong> Commands, replies and errors come from Valkey's code, not a
            reimplementation. Clients connect over TCP, a WebSocket or a service binding.
          </li>
          <li>
            <strong>Durable writes.</strong> A reply leaves only after its AOF entry is committed to SQLite.
          </li>
          <li>
            <strong>Placement you choose.</strong> Shards in the regions you pick, and read replicas in others if you
            want them. A connection always reads its own writes, and <code>WAIT</code> counts the replicas that have
            them.
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
            The AUTH username picks the database, and a new one is created on first use. From a laptop, the WebSocket
            shim gives any client a local TCP port:
          </p>
          <Code label="Terminal">
            {
              'npx vado-shim wss://<your-worker>.workers.dev/ws 6379\nvalkey-cli -p 6379 --user mydb --pass "$VALKEY_PASSWORD"\n127.0.0.1:6379> SET greeting hello\nOK'
            }
          </Code>
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
