import { ArrowRightIcon } from "@phosphor-icons/react";
import { Fragment } from "react";
import type { ReactNode } from "react";
import { SERVERS } from "../../content/servers";
import { ByServer, ServerName } from "../server";
import { OriginLegend } from "./wasm-layers";
import type { Origin } from "./wasm-layers";

interface Step {
  origin: Origin;
  title: string;
  sub: ReactNode;
}

const wasmFile = <ByServer valkey={<code>valkey.wasm</code>} redis={<code>redis.wasm</code>} />;

const STAGES: { title: string; steps: Step[] }[] = [
  {
    title: "Fetch",
    steps: [
      {
        origin: "upstream",
        title: "Release tarball",
        sub: (
          <>
            <ServerName /> <ByServer valkey={SERVERS.valkey.version} redis={SERVERS.redis.version} /> from GitHub,
            sha256 pinned in <code>build.sh</code>
          </>
        ),
      },
      {
        origin: "ours",
        title: "Apply patches",
        sub: (
          <>
            <code>patches/*.patch</code> in name order, zero fuzz
          </>
        ),
      },
    ],
  },
  {
    title: "Build with wasi-sdk 34",
    steps: [
      {
        origin: "toolchain",
        title: "Compile",
        sub: (
          <>
            clang for <code>wasm32-wasip1</code>: the server, Lua and deps, plus our <code>wasi/</code> shims and{" "}
            <code>stubs.c</code>
          </>
        ),
      },
      {
        origin: "toolchain",
        title: "Link a reactor",
        sub: (
          <>
            <code>-mexec-model=reactor</code>: no <code>_start</code>, exports instead
          </>
        ),
      },
      {
        origin: "toolchain",
        title: "wasm-opt",
        sub: "Optimize again, drop DWARF, keep function names",
      },
    ],
  },
  {
    title: "Ship",
    steps: [
      {
        origin: "ours",
        title: "Committed module",
        sub: <>{wasmFile} and interface.txt. CI rebuilds both and needs the same bytes</>,
      },
      {
        origin: "ours",
        title: "Shard object",
        sub: "Each shard's Durable Object instantiates its own copy",
      },
    ],
  },
];

export function PipelineDiagram() {
  let number = 0;

  return (
    <figure className="diagram-card">
      <div className="diagram-top">
        <span className="status">The build, in seven steps</span>
        <span className="max-md:hidden">build.sh runs 1 to 5</span>
      </div>
      <div className="pipeline" role="list" aria-label="Build steps, in order">
        {STAGES.map((stage, index) => (
          <Fragment key={stage.title}>
            {index > 0 && <ArrowRightIcon className="pipeline-arrow" aria-hidden="true" />}
            <div className="pipeline-stage" role="listitem">
              <span className="pipeline-stage-title">{stage.title}</span>
              <ol>
                {stage.steps.map((step) => {
                  number += 1;

                  return (
                    <li key={step.title} className="pipeline-step" data-origin={step.origin}>
                      <strong>
                        <span className="pipeline-number">{number}</span>
                        {step.title}
                      </strong>
                      <span>{step.sub}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          </Fragment>
        ))}
      </div>
      <OriginLegend />
    </figure>
  );
}
