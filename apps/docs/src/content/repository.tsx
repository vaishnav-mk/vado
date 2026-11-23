import { FolderOpenIcon } from "@phosphor-icons/react";
import { Code, Table } from "../components/blocks";
import { source } from "./sources";
import type { Doc } from "./types";

export const repository: Doc = {
  slug: "repository",
  title: "Repository",
  group: "Develop",
  icon: FolderOpenIcon,
  description:
    "An npm workspace: two apps and three packages. How to check, test and build it, and what CI runs on every push.",
  keywords: "repository layout monorepo apps packages develop check test build e2e ci workflows wasm build lint",
  sections: [
    {
      id: "layout",
      title: "Layout",
      content: (
        <Table
          headers={["Path", "What"]}
          rows={[
            [
              "apps/dashboard",
              "The dashboard (TanStack Start, React, Kumo) and the Worker's entry, src/server.ts, which exports every Durable Object class",
            ],
            ["apps/docs", "This site, deployed as its own Worker, vado-docs"],
            ["packages/server", "The database: router, shards, replication, catalog, admin and the bench API"],
            ["packages/client", "bindingConnector for ioredis over a service binding, and vado-shim"],
            ["packages/wasm", "The Valkey and Redis wasm builds: patches, build scripts and the committed binaries"],
            ["test/", "End-to-end tests against a deployed Worker"],
            ["tools/oxlint", "The vendored anti-slop lint plugin"],
          ]}
        />
      ),
    },
    {
      id: "commands",
      title: "Commands",
      content: (
        <>
          <Code label="From the repository root">
            {
              "npm install\nnpm run dev      # the dashboard and database on http://localhost:5173\nnpm run docs     # this site\nnpm run check    # format, lint (oxlint with anti-slop) and type-check\nnpm test         # unit tests, in plain Node\nnpm run build    # build the Worker\nnpm run deploy   # build, then deploy it"
            }
          </Code>
          <p>
            The Worker's <code>wrangler.jsonc</code> stays at the repository root, where the Deploy to Cloudflare button
            reads it, with <code>main</code> pointing at <code>apps/dashboard/src/server.ts</code>.{" "}
            <code>npm run deploy</code> builds <code>apps/dashboard</code>, then deploys the generated config in{" "}
            <code>apps/dashboard/dist/server</code>.
          </p>
        </>
      ),
    },
    {
      id: "e2e",
      title: "End-to-end tests",
      content: (
        <>
          <p>
            <code>test/e2e.sh</code> runs every check against a deployed Worker on fresh databases: stock ioredis,
            RESP3, chunked requests, WATCH across a reset, 1 shard against N, the hammer's invariants, and the bench
            durability, replica and drop checks.
          </p>
          <Code label="Against your own deployment">
            {
              "npx vado-shim wss://<your-worker>.workers.dev/ws 6379 &\nBASE=https://<your-worker>.workers.dev TOKEN=<BENCH_TOKEN> PW=<VALKEY_PASSWORD> test/e2e.sh"
            }
          </Code>
          <p>
            <code>FLAVOUR=redis</code> runs it on Redis, if the Worker carries it. <code>HOST</code> and{" "}
            <code>PORT</code> point it at another TCP address, such as a Spectrum application.
          </p>
        </>
      ),
    },
    {
      id: "ci",
      title: "Continuous integration",
      content: (
        <Table
          headers={["Workflow", "Runs"]}
          rows={[
            ["ci.yml", "Every push and pull request: check, unit tests and a build"],
            [
              "wasm.yml",
              "Changes under packages/wasm: rebuilds Valkey and Redis and fails unless the bytes and the host interface match the committed ones",
            ],
            [
              "e2e.yml",
              "Pushes to main: deploys to a throwaway Worker, vado-e2e, and runs test/e2e.sh on both servers. Off until the repository has CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and the variable E2E=on",
            ],
            ["valkey-release.yml", "Weekly: opens an issue when a newer Valkey is out, with a test build's results"],
          ]}
        />
      ),
    },
    {
      id: "wasm",
      title: "The wasm builds",
      content: (
        <>
          <Code label="Needs wasi-sdk 34 and binaryen's wasm-opt">
            {
              "WASI_SDK=/path/to/wasi-sdk-34.0 packages/wasm/valkey/build.sh\nWASI_SDK=/path/to/wasi-sdk-34.0 packages/wasm/redis/build.sh"
            }
          </Code>
          <p>
            Each build downloads a pinned, checksummed release, applies its patches in order, compiles with the shared
            WASI shims and runs <code>wasm-opt</code>. The same toolchain gives the same bytes on any machine.{" "}
            <code>interface.txt</code> lists what the host must provide and may call, so a patch that changes that
            contract shows up as a diff of names. Changes to a server go in its patches, never in a branch in the
            TypeScript.
          </p>
        </>
      ),
    },
    {
      id: "rules",
      title: "Code rules",
      content: (
        <p>
          TypeScript, strict, with no lint suppressions. At most 250 lines a file. Each directory keeps its types in{" "}
          <code>types.ts</code> and its tunables in <code>config.ts</code>. Few comments, only the why the code can't
          show. The invariants every change must keep are in <code>AGENTS.md</code>.
        </p>
      ),
    },
  ],
  sources: [
    source("AGENTS.md"),
    source("package.json"),
    source("test/e2e.sh"),
    source(".github/workflows/ci.yml"),
    source(".github/workflows/wasm.yml"),
    source("packages/wasm/README.md"),
  ],
};
