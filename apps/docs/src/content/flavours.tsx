import { SquaresFourIcon } from "@phosphor-icons/react";
import { Code, Note, Table } from "../components/blocks";
import { CONTAINER_SECTIONS } from "./flavours-containers";
import { RUNNING_SECTIONS } from "./flavours-running";
import { server, source } from "./sources";
import type { Doc } from "./types";

export const flavours: Doc = {
  slug: "flavours",
  title: "Flavours",
  group: "Run it",
  icon: SquaresFourIcon,
  description:
    "Valkey 9.1.1 or Redis 8.12.0, compiled to wasm inside each shard's Durable Object, or unmodified in a container beside it. A database picks one of the four when it is created.",
  keywords:
    "flavour flavours valkey redis valkey-native redis-native native container containers wasm VADO_REDIS VADO_CONTAINERS agpl licence license import-mode",
  intro: (
    <p>
      Routing, AUTH, the catalog, durability rules and the dashboard are the same code for all four. Clients can't tell
      them apart beyond <code>INFO</code>; one connection can switch between databases of different flavours with AUTH.
    </p>
  ),
  sections: [
    {
      id: "four",
      title: "The four flavours",
      content: (
        <>
          <Table
            headers={["", "In the Durable Object (wasm)", "In a container (native)"]}
            rows={[
              [
                "Valkey 9.1.1",
                <>
                  <code>valkey</code>, in every build
                </>,
                <>
                  <code>valkey-native</code>, with <code>VADO_CONTAINERS=1</code>
                </>,
              ],
              [
                "Redis 8.12.0",
                <>
                  <code>redis</code>, with <code>VADO_REDIS=1</code>
                </>,
                <>
                  <code>redis-native</code>, with both
                </>,
              ],
            ]}
          />
          <Table
            headers={["", "In the Durable Object", "In a container"]}
            rows={[
              ["Data per shard", "64 MB", "2 GB by default"],
              ["The server", "Compiled to wasm, with a few patches", "As released, built from the same tarball"],
              ["Read replicas", "Yes", "Not yet"],
              [
                "While idle",
                "The object sleeps, at no cost",
                "The container stops 10 to 15 minutes after its last client",
              ],
              ["First command after idling", "0.2-0.8 s", "About 2-4 s for 170 MB; more for more data"],
              ["Platform", "Durable Objects", "Containers, on the durable_object scheduling policy (beta)"],
            ]}
          />
        </>
      ),
    },
    {
      id: "building",
      title: "Building",
      content: (
        <>
          <Code label="Terminal">
            {
              "npm run deploy                                  # valkey\nVADO_REDIS=1 npm run deploy                     # and redis\nVADO_CONTAINERS=1 npm run deploy                # and valkey-native (needs Docker)\nVADO_REDIS=1 VADO_CONTAINERS=1 npm run deploy   # all four"
            }
          </Code>
          <p>
            Redis is opt-in because it doubles the upload, from 0.86 MB to 1.77 MB gzipped, and is distributed under the
            AGPLv3. On their own, <code>valkey.wasm</code> is 1.94 MB (0.75 MB gzipped) and <code>redis.wasm</code> is
            2.38 MB (0.93 MB gzipped). A native flavour needs its wasm build too, which answers <code>COMMAND</code> for
            the routers.
          </p>
          <p>
            <code>VADO_CONTAINERS=1</code> adds a container application with an image of each server the build carries.
            Docker builds them from <code>packages/box/Dockerfile</code> during the deploy; to skip that, set{" "}
            <code>VADO_VALKEY_IMAGE</code> and <code>VADO_REDIS_IMAGE</code> to digest-pinned images you pushed to the
            Cloudflare registry with <code>wrangler containers push</code>. <code>VADO_CONTAINER_APP</code> names the
            application, for two vado Workers on one account. <code>BOX_MAXMEMORY</code> sets the containers'{" "}
            <code>maxmemory</code> (default <code>2gb</code>, on a <code>standard-1</code> instance with 4 GiB).
          </p>
        </>
      ),
    },
    {
      id: "creating",
      title: "Creating a database",
      content: (
        <>
          <Code label="Terminal">
            {
              'curl -H "authorization: Bearer $BENCH_TOKEN" \\\n  "https://<worker>/db?db=big&shards=16&flavour=valkey-native"'
            }
          </Code>
          <p>
            The flavour is picked at creation, in the dashboard or with <code>flavour=</code> on the bench API, and
            never changes. A database made by its first AUTH runs Valkey in its objects. Every object's name carries the
            flavour, so each one boots the right server from its name alone.
          </p>
        </>
      ),
    },
    {
      id: "redis-wasm",
      title: "Redis in wasm",
      content: (
        <ul>
          <li>
            Redis lacks Valkey's <code>import-mode</code>, which replicas and rewriters need so nothing expires on its
            own. A patch adds it.
          </li>
          <li>
            Redis has no <code>CLIENT IMPORT-SOURCE</code>; with that patch, every write on a replica counts as the
            primary's stream.
          </li>
          <li>
            <code>INFO</code> shows <code>executable:/valkey-server</code>, the name the shared host code passes.
          </li>
        </ul>
      ),
    },
    {
      id: "licence",
      title: "Licences",
      content: (
        <>
          <p>
            Valkey is BSD 3-Clause. Redis 8 is available under RSALv2, SSPLv1 or AGPLv3; <code>redis.wasm</code>, its
            patches and stubs, and the Redis container image are distributed under the AGPLv3. The rest of vado is
            Apache-2.0.
          </p>
          <Note>
            <p>
              The AGPL's network clause means that if you run a Redis flavour for other people, you must offer them its
              source: the Redis tarball pinned in <code>packages/wasm/redis/build.sh</code> and{" "}
              <code>packages/box/Dockerfile</code>, <code>packages/wasm/redis/</code>, and{" "}
              <code>packages/wasm/wasi/</code>.
            </p>
          </Note>
        </>
      ),
    },
    ...CONTAINER_SECTIONS,
    ...RUNNING_SECTIONS,
  ],
  sources: [
    server("catalog/flavours.ts"),
    server("box/box.ts"),
    server("box/engine.ts"),
    server("box/link.ts"),
    server("box/container.ts"),
    source("packages/box/Dockerfile"),
    source("packages/wasm/redis/patches"),
    source("NOTICE"),
  ],
};
