import { CpuIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Facts } from "../components/blocks";
import { LayersDiagram } from "../components/diagrams/wasm-layers";
import { PipelineDiagram } from "../components/diagrams/wasm-pipeline";
import { DocLink } from "../components/doc-link";
import { ByServer, ServerBadge, ServerName } from "../components/server";
import { SERVERS } from "./servers";
import type { Server } from "./servers";
import { server, source } from "./sources";
import type { Doc } from "./types";
import { BOUNDARY_SECTIONS } from "./wasm-boundary";
import { BUILD_SECTIONS } from "./wasm-build";
import { CHANGE_SECTIONS } from "./wasm-changes";
import { patchTotals } from "./wasm-patch-list";
import { PATCH_SECTIONS } from "./wasm-patches";
import { FORK_SECTIONS, REACTOR_SECTIONS } from "./wasm-runtime";

function glance(name: Server): [ReactNode, ReactNode][] {
  const facts = SERVERS[name];
  const { count, changed } = patchTotals(name);

  return [
    [
      "Upstream",
      <>
        {facts.name} {facts.version}, the release tarball from GitHub, pinned by sha256
      </>,
    ],
    [
      "We patch",
      <>
        <a href="#patches">
          {count} small patches, {changed} changed lines
        </a>{" "}
        in all
      </>,
    ],
    [
      "We add",
      <>
        <a href="#adds">Shims</a> for sockets, the event loop and the <code>rk_*</code> exports, plus missing headers
      </>,
    ],
    [
      "We turn off",
      <>
        <a href="#turned-off">fork, threads, TLS{name === "valkey" ? ", RDMA" : ""}, dlopen and backtraces</a>
      </>,
    ],
    [
      "Module",
      <>
        <code>{name}.wasm</code>, {facts.wasm}, one instance per shard
      </>,
    ],
    ["Built with", "wasi-sdk 34 and binaryen's wasm-opt (version_133 in CI)"],
    ["Licence", facts.licence],
  ];
}

export const wasm: Doc = {
  slug: "wasm",
  title: "WebAssembly builds",
  group: "How it works",
  icon: CpuIcon,
  description:
    "How packages/wasm turns a pinned Valkey or Redis release into a WASI reactor module: what stays upstream, what we patch, add and turn off, how the host runs it, and how to change or upgrade a build.",
  keywords:
    "wasm webassembly wasi wasi-sdk binaryen wasm-opt build.sh common.sh update.sh patches reactor interface.txt dlmalloc sock_shim host imports fork aof rewrite reproducible upstream stubs shims",
  intro: (
    <>
      <p>
        Each shard runs the real <ServerName /> server, compiled to WebAssembly. The build starts from the upstream
        release, changes as little as it can, and commits the module to the repository.
      </p>
      <p>
        Both builds share one toolchain, one set of shims in <code>packages/wasm/wasi/</code> and one host. Where they
        differ, the page follows the server picked in the header: <ServerBadge />.
      </p>
    </>
  ),
  sections: [
    {
      id: "at-a-glance",
      title: "At a glance",
      content: <ByServer valkey={<Facts items={glance("valkey")} />} redis={<Facts items={glance("redis")} />} />,
    },
    {
      id: "pipeline",
      title: "From release tarball to running shard",
      content: (
        <>
          <p>
            <ByServer
              valkey={<code>packages/wasm/valkey/build.sh</code>}
              redis={<code>packages/wasm/redis/build.sh</code>}
            />{" "}
            runs the first five steps. The output is committed, and CI rebuilds it to prove the bytes match (
            <a href="#build">Building it</a>).
          </p>
          <PipelineDiagram />
        </>
      ),
    },
    {
      id: "layers",
      title: "What's upstream and what's ours",
      content: (
        <>
          <p>
            Most of the module is upstream code. Ours is a thin layer around it: a few patches inside, shims and stubs
            beside it, and the host on the other side of the wasm boundary.
          </p>
          <LayersDiagram />
        </>
      ),
    },
    ...PATCH_SECTIONS,
    ...REACTOR_SECTIONS,
    ...BOUNDARY_SECTIONS,
    ...FORK_SECTIONS,
    ...BUILD_SECTIONS,
    ...CHANGE_SECTIONS,
    {
      id: "licence",
      title: "Licences",
      content: (
        <ByServer
          valkey={
            <p>
              The Valkey build, its patches and the shared shims are BSD 3-Clause (<code>packages/wasm/LICENSE</code>),
              like Valkey itself.
            </p>
          }
          redis={
            <p>
              <code>redis.wasm</code>, its patches and stubs are distributed under the AGPLv3 (
              <DocLink slug="flavours" hash="licence">
                Redis
              </DocLink>
              ). Anyone running the Redis flavour for others must offer them the pinned tarball,{" "}
              <code>packages/wasm/redis/</code> and <code>packages/wasm/wasi/</code>.
            </p>
          }
        />
      ),
    },
  ],
  sources: [
    source("packages/wasm/common.sh"),
    source("packages/wasm/valkey/build.sh"),
    source("packages/wasm/redis/build.sh"),
    source("packages/wasm/update.sh"),
    source("packages/wasm/valkey/patches"),
    source("packages/wasm/redis/patches"),
    source("packages/wasm/wasi"),
    source("packages/wasm/interface.mjs"),
    server("shard/host/valkey-host.ts"),
    server("shard/host/loop.ts"),
    server("shard/host/wasi.ts"),
    server("shard/host/sockets.ts"),
    server("shard/host/aof-rewrite.ts"),
    server("shard/vfs/vfs.ts"),
    source(".github/workflows/wasm.yml"),
  ],
};
