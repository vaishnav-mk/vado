import { SquaresFourIcon } from "@phosphor-icons/react";
import { Table } from "../components/blocks";
import { PlacementDiagram } from "../components/diagrams/flavours-placement";
import { DocLink } from "../components/doc-link";
import { ServerBadge } from "../components/server";
import { CONTAINER_SECTIONS } from "./flavours-containers";
import { RUNNING_SECTIONS } from "./flavours-running";
import { SETUP_SECTIONS } from "./flavours-setup";
import { SERVERS } from "./servers";
import { server, source } from "./sources";
import type { Doc } from "./types";

export const flavours: Doc = {
  slug: "flavours",
  title: "Flavours",
  group: "Run it",
  icon: SquaresFourIcon,
  description: `Valkey ${SERVERS.valkey.version} or Redis ${SERVERS.redis.version}, compiled to wasm inside each shard's Durable Object, or unmodified in a container beside it. A database picks one of the four when it is created.`,
  keywords:
    "flavour flavours valkey redis valkey-native redis-native native container containers wasm VADO_REDIS VADO_CONTAINERS agpl licence license import-mode generations restore",
  intro: (
    <>
      <p>The four differ in the server and where it runs. The rest is shared:</p>
      <ul>
        <li>Routing, AUTH, the catalog, durability rules and the dashboard are the same code for all four.</li>
        <li>
          Clients can't tell them apart beyond <code>INFO</code>.
        </li>
        <li>One connection can switch between databases of different flavours with AUTH.</li>
      </ul>
    </>
  ),
  sections: [
    {
      id: "four",
      title: "The four flavours at a glance",
      content: (
        <Table
          headers={["", "In the Durable Object (wasm)", "In a container (native)"]}
          rows={[
            [
              <>
                <ServerBadge server="valkey" /> {SERVERS.valkey.version}
              </>,
              <code>valkey</code>,
              <code>valkey-native</code>,
            ],
            [
              <>
                <ServerBadge server="redis" /> {SERVERS.redis.version}
              </>,
              <code>redis</code>,
              <code>redis-native</code>,
            ],
            [
              "The server",
              <>
                Compiled to wasm, with{" "}
                <DocLink slug="wasm" hash="patches">
                  a few patches
                </DocLink>
                , inside the object
              </>,
              "As released, built from the same tarball, in a container beside the object",
            ],
            [
              "Data per shard",
              <strong>64 MB</strong>,
              <>
                <strong>2 GB</strong> by default
              </>,
            ],
            [
              "First command after idling",
              <>
                <strong>0.2-0.8 s</strong> (
                <DocLink slug="measurements" hash="cold-starts">
                  cold starts
                </DocLink>
                )
              </>,
              <>
                About <strong>2-4 s</strong> for 170 MB, more for more data
              </>,
            ],
            [
              "While idle",
              <>
                The object sleeps, at <strong>no cost</strong>
              </>,
              <>
                The container stops <strong>10 to 15 minutes</strong> after its last client (
                <a href="#idle">idle containers</a>)
              </>,
            ],
            [
              "While running",
              "The Durable Object only",
              <>
                About <strong>$0.038 an hour</strong> per shard for the container, plus CPU while busy, on top of its
                Durable Object
              </>,
            ],
            ["Read replicas", <DocLink slug="replicas">Yes</DocLink>, <strong>Not yet</strong>],
            [
              "Deploy flag",
              <>
                None for <code>valkey</code>. <code>VADO_REDIS=1</code> for <code>redis</code>
              </>,
              <>
                <code>VADO_CONTAINERS=1</code>. <code>redis-native</code> needs <code>VADO_REDIS=1</code> too
              </>,
            ],
            [
              "Platform",
              "Durable Objects",
              <>
                Containers, on the <code>durable_object</code> scheduling policy (beta)
              </>,
            ],
          ]}
        />
      ),
    },
    {
      id: "where",
      title: "Where the server runs",
      content: (
        <>
          <PlacementDiagram />
          <ul>
            <li>
              In <code>valkey</code> and <code>redis</code>, the shard's Durable Object runs the server itself (
              <DocLink slug="wasm">WebAssembly builds</DocLink>).
            </li>
            <li>
              In <code>valkey-native</code> and <code>redis-native</code>, the server runs unmodified in a container
              beside the object. The object is its replica and stores its replication stream (
              <a href="#durability">how</a>).
            </li>
            <li>
              A native flavour needs its wasm build too. It answers <code>COMMAND</code> for the routers.
            </li>
          </ul>
        </>
      ),
    },
    ...SETUP_SECTIONS,
    ...CONTAINER_SECTIONS,
    ...RUNNING_SECTIONS,
  ],
  sources: [
    server("catalog/flavours.ts"),
    server("container-shard/box.ts"),
    server("container-shard/engine.ts"),
    server("container-shard/link.ts"),
    server("container-shard/container.ts"),
    server("container-shard/store.ts"),
    source("packages/box/Dockerfile"),
    source("packages/wasm/redis/patches"),
    source("NOTICE"),
  ],
};
