import type { ReactNode } from "react";
import type { Server } from "./servers";

export type PatchGroup = "run" | "both" | "chosen";

export interface Patch {
  file: string;
  group: PatchGroup;
  what: ReactNode;
  why: ReactNode;
  /** Lines starting with + or - in the patch file, headers excluded. */
  added: number;
  removed: number;
}

const AE: Patch = {
  file: "0001-ae-wasi-backend",
  group: "run",
  what: (
    <>
      With <code>HAVE_WASI_AE</code>, <code>ae.c</code> includes our <code>wasi/ae_wasi.c</code> instead of epoll or
      kqueue.
    </>
  ),
  why: "Its poll asks the host which fds are ready and never blocks.",
  added: 4,
  removed: 0,
};

const MAIN: Patch = {
  file: "0002-reactor-main",
  group: "run",
  what: (
    <>
      <code>main()</code> returns after init instead of entering <code>aeMain</code>.
    </>
  ),
  why: "The host runs the event loop through the reactor exports.",
  added: 8,
  removed: 0,
};

const utc = (file: string): Patch => ({
  file,
  group: "chosen",
  what: (
    <>
      <code>getTimeZone()</code> returns 0, so log times are UTC.
    </>
  ),
  why: "WASI has no time zones and never fills in gettimeofday()'s time zone, so log dates came out wrong.",
  added: 2,
  removed: 0,
});

export const PATCHES: Record<Server, Patch[]> = {
  valkey: [
    AE,
    MAIN,
    {
      file: "0003-inline-aof-rewrite",
      group: "run",
      what: (
        <>
          <code>rewriteAppendOnlyFileBackground()</code> runs the child's rewrite inline, then calls{" "}
          <code>backgroundRewriteDoneHandler()</code> as if the child had exited.
        </>
      ),
      why: "There is no fork(). This blocks the server for the rewrite.",
      added: 19,
      removed: 0,
    },
    {
      file: "0004-host-aof-rewrite",
      group: "chosen",
      what: (
        <>
          Before rewriting inline, offers the rewrite to the host through the <code>aof_rewrite</code> import. Adds the{" "}
          <code>rk_rewrite_done</code> export.
        </>
      ),
      why: "The host can write the new base elsewhere while Valkey keeps serving.",
      added: 27,
      removed: 0,
    },
    utc("0005-utc-log-times"),
  ],
  redis: [
    AE,
    MAIN,
    {
      file: "0003-aof-rewrite-without-fork",
      group: "both",
      what: (
        <>
          Valkey's <code>0003</code> and <code>0004</code> in one: offer the rewrite to the host, otherwise rewrite
          inline. Adds <code>rk_rewrite_done</code>.
        </>
      ),
      why: "There is no fork(), so the inline rewrite is needed. Offering it to the host is a choice: the host can write the base while Redis keeps serving.",
      added: 45,
      removed: 0,
    },
    {
      file: "0004-no-context-switch-counts",
      group: "run",
      what: (
        <>
          The slowlog's CPU sample sets <code>nvcsw</code> and <code>nivcsw</code> to 0.
        </>
      ),
      why: "WASI's rusage has no ru_nvcsw or ru_nivcsw.",
      added: 4,
      removed: 0,
    },
    {
      file: "0005-import-mode",
      group: "chosen",
      what: (
        <>
          Adds Valkey's <code>import-mode</code> config: no active expiry. Writes see expired keys and hash fields as
          alive, everything else sees them as gone, and nothing deletes them.
        </>
      ),
      why: "Read replicas and rewriters run with it, so only the primary's stream deletes keys.",
      added: 19,
      removed: 3,
    },
    utc("0006-utc-log-times"),
  ],
};

export function patchTotals(server: Server) {
  const patches = PATCHES[server];
  let added = 0;
  let removed = 0;

  for (const patch of patches) {
    added += patch.added;
    removed += patch.removed;
  }

  return { count: patches.length, added, removed, changed: added + removed };
}
