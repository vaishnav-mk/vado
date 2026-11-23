import type { ReactNode } from "react";
import { ServerName } from "../server";

type Lane = "module" | "host";

interface Row {
  /** Where the box sits, or where an arrow starts. */
  lane: Lane;
  arrow?: boolean;
  text: ReactNode;
}

const SPEAKER: Record<Lane, [string, string]> = {
  module: ["In the module:", "Module to host:"],
  host: ["In the host:", "Host to module:"],
};

const ROWS: Row[] = [
  {
    lane: "host",
    arrow: true,
    text: <>The shard sends BGREWRITEAOF</>,
  },
  {
    lane: "module",
    text: <>Opens a new incremental file, as it would before a fork</>,
  },
  {
    lane: "module",
    arrow: true,
    text: (
      <>
        <code>host.aof_rewrite(tmpfile, rdb, generation)</code>, only while the AOF is on
      </>
    ),
  },
  {
    lane: "host",
    arrow: true,
    text: (
      <>
        Returns 1: taken. (0: <ServerName /> rewrites inline and blocks until done)
      </>
    ),
  },
  {
    lane: "module",
    text: <>Keeps serving, with an AOF child marked as running</>,
  },
  {
    lane: "host",
    text: (
      <>
        A rewriter object rebuilds the base from the files before the new incremental file and writes{" "}
        <code>tmpfile</code>
      </>
    ),
  },
  {
    lane: "host",
    arrow: true,
    text: (
      <>
        <code>rk_rewrite_done(ok, generation)</code>
      </>
    ),
  },
  {
    lane: "module",
    arrow: true,
    text: <>Finishes as when a child exits and returns 1. Returns 0 if that rewrite was killed meanwhile</>,
  },
  {
    lane: "host",
    text: (
      <>
        On 0, deletes <code>tmpfile</code>
      </>
    ),
  },
];

export function RewriteSequence() {
  return (
    <figure className="diagram-card">
      <div className="diagram-top">
        <span className="status">Who does what</span>
        <span className="max-md:hidden">Time runs down the page</span>
      </div>
      <div className="sequence">
        <div className="sequence-heads" aria-hidden="true">
          <span data-origin="upstream">
            Module: <ServerName />
          </span>
          <span data-origin="ours">Host: shard object</span>
        </div>
        <ol>
          {ROWS.map((row, index) => (
            <li key={index} className={row.arrow === true ? "sequence-arrow" : "sequence-note"} data-lane={row.lane}>
              <span className="sequence-number">{index + 1}</span>
              <span className="sr-only">{SPEAKER[row.lane][row.arrow === true ? 1 : 0]}</span>
              <span>{row.text}</span>
            </li>
          ))}
        </ol>
      </div>
    </figure>
  );
}
