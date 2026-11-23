import { CubeIcon } from "@phosphor-icons/react";
import { Code, Note } from "../components/blocks";
import { source } from "./sources";
import type { Doc } from "./types";

export const redis: Doc = {
  slug: "redis",
  title: "Redis",
  group: "Run it",
  icon: CubeIcon,
  description:
    "A database can run Redis 8.12.0 instead of Valkey. It is opt-in at build time because it doubles the upload and is distributed under the AGPLv3.",
  keywords: "redis flavour agpl license licence VADO_REDIS build redis.wasm import-mode",
  sections: [
    {
      id: "choosing",
      title: "Choosing Redis",
      content: (
        <>
          <p>
            The flavour is picked when a database is created, with <code>flavour=redis</code> on the bench API's{" "}
            <code>/db</code>, and never changes. A database created on its first AUTH runs Valkey. A Redis database's
            object names carry a <code>redis</code> segment, so every object boots the right server from its own name.
          </p>
          <p>
            Routing, replication, rewrites and restarts are the same code for both: the two wasm builds have the same
            exports and almost the same imports. One connection can switch between a Valkey and a Redis database with
            AUTH.
          </p>
        </>
      ),
    },
    {
      id: "building",
      title: "Building with Redis",
      content: (
        <>
          <Code label="Terminal">{"VADO_REDIS=1 npm run deploy"}</Code>
          <p>
            Without <code>VADO_REDIS=1</code>, the build leaves Redis out and every database runs Valkey. With it, the
            Worker upload grows from 0.86 MB to 1.77 MB gzipped; startup time didn't measurably change, since wasm
            compiles lazily. On their own, <code>valkey.wasm</code> is 1.94 MB (0.75 MB gzipped) and{" "}
            <code>redis.wasm</code> is 2.38 MB (0.93 MB gzipped).
          </p>
        </>
      ),
    },
    {
      id: "differences",
      title: "Differences",
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
      title: "The AGPL licence",
      content: (
        <>
          <p>
            Redis 8 is available under RSALv2, SSPLv1 or AGPLv3. <code>redis.wasm</code> and its patches and stubs are
            distributed under the AGPLv3. The rest of vado is Apache-2.0, and <code>valkey.wasm</code> is BSD 3-Clause.
          </p>
          <Note>
            <p>
              The AGPL's network clause means that if you run the Redis flavour for other people, you must offer them
              its source: the Redis tarball pinned in <code>packages/wasm/redis/build.sh</code>, that directory, and{" "}
              <code>packages/wasm/wasi/</code>.
            </p>
          </Note>
        </>
      ),
    },
  ],
  sources: [
    source("packages/wasm/redis/README.md"),
    source("packages/wasm/redis/build.sh"),
    source("packages/wasm/redis/patches"),
    source("NOTICE"),
  ],
};
