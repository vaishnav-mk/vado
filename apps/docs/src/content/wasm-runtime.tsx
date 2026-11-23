import type { ReactNode } from "react";
import { Note, Table } from "../components/blocks";
import { DocLink } from "../components/doc-link";
import { ByServer } from "../components/server";
import type { DocSection } from "./types";

const PATCH_HEADERS = ["Patch", "Changes", "Why"];

const AE: ReactNode[] = [
  "0001-ae-wasi-backend",
  <>
    With <code>HAVE_WASI_AE</code>, <code>ae.c</code> includes <code>wasi/ae_wasi.c</code> instead of epoll or kqueue
  </>,
  "Its poll asks the host which fds are ready and never blocks",
];

const MAIN: ReactNode[] = [
  "0002-reactor-main",
  <>
    <code>main()</code> returns after init instead of entering <code>aeMain</code>
  </>,
  "The host runs the event loop through the reactor exports",
];

const utc = (name: string): ReactNode[] => [
  name,
  <>
    <code>getTimeZone()</code> returns 0, so log times are UTC
  </>,
  "WASI has no time zones and never fills in gettimeofday()'s time zone, so log dates came out wrong",
];

export const RUNTIME_SECTIONS: DocSection[] = [
  {
    id: "reactor",
    title: "The reactor model",
    content: (
      <>
        <p>
          A Durable Object runs the module on the same thread as its event loop, so the server can never block in{" "}
          <code>aeMain</code>. The <code>0002</code> patch makes <code>main()</code> return after initialization, and
          the host drives the event loop one non-blocking pass at a time. All server state stays in the instance's
          linear memory between calls.
        </p>
        <Table
          headers={["Export", "What the host does with it"]}
          rows={[
            [<code>_initialize</code>, "Called once after instantiation: wasi-libc's constructors"],
            [
              <code>rk_args_ptr, rk_args_cap, rk_boot_args</code>,
              "Writes NUL-separated arguments into an 8 KB buffer and boots with them; init loads the AOF",
            ],
            [
              <code>rk_tick</code>,
              "One pass in aeMain's order (afterSleep, events, timers, beforeSleep), so the AOF write and reply flush happen in the same call",
            ],
            [
              <code>rk_next_timeout_ms</code>,
              "1000 / hz; the host's serverCron timer interval, at least 20 ms, running only while clients are connected",
            ],
            [<code>rk_rewrite_done</code>, "Finishes an AOF rewrite the host took (below)"],
            [
              <code>rk_boot, rk_step</code>,
              "Exported by reactor.c (a fixed argument list; a pass that runs beforeSleep first) but unused by the host",
            ],
            [
              <code>memory, __stack_pointer</code>,
              "The host reads and writes linear memory directly, so no copy exports are needed",
            ],
          ]}
        />
        <Note>
          <p>
            The allocator is wasi-libc's dlmalloc. Linear memory never shrinks, and with dlmalloc it measured 1.08 to
            1.29 times Valkey's <code>used_memory</code>; a mimalloc build measured 1.6 to 4.3 times (
            <DocLink slug="measurements" hash="memory">
              measurements
            </DocLink>
            ).
          </p>
        </Note>
      </>
    ),
  },
  {
    id: "shims",
    title: "Shims and stubs",
    content: (
      <Table
        headers={["File", "What it provides"]}
        rows={[
          [<code>wasi/reactor.c</code>, "The rk_* exports"],
          [<code>wasi/ae_wasi.c</code>, "The event loop backend over host.poll, tracking only fds with a nonzero mask"],
          [
            <code>wasi/sock_shim.c</code>,
            "socket(), listen(), accept(), getaddrinfo() and the wrapped read, write, writev, close and fcntl",
          ],
          [<code>wasi/host.h</code>, "Declarations of the host imports"],
          [
            <code>wasi/wasm_compat.h</code>,
            "fork() and wait3() as -1, waitpid() as 0, kill() failing with ESRCH, no-op signals, timers and rlimits, missing errno and socket constants",
          ],
          [
            <code>wasi/wasm_sjlj.c</code>,
            "The setjmp and longjmp helpers LLVM's lowering calls; wasi-sdk doesn't ship them",
          ],
          [
            <code>wasi/*.h, wasi/sys/*.h</code>,
            "grp.h, netdb.h, syslog.h, termios.h, sys/un.h and sys/wait.h, which the sysroot lacks or leaves incomplete",
          ],
          [
            <code>valkey/stubs.c, redis/stubs.c</code>,
            "bio jobs run inline; io-threads, dlopen, TLS, backtraces and the sentinel's async client fail or do nothing",
          ],
        ]}
      />
    ),
  },
  {
    id: "patches",
    title: "Patches",
    content: (
      <>
        <p>
          Each patch is a few lines, made against the release tarball. What the sandbox needs sits under{" "}
          <code>#ifdef VALKEY_WASM</code> or <code>HAVE_WASI_AE</code>; Redis's <code>import-mode</code> is the one
          feature added outright.
        </p>
        <ByServer
          valkey={
            <Table
              headers={PATCH_HEADERS}
              rows={[
                AE,
                MAIN,
                [
                  "0003-inline-aof-rewrite",
                  <>
                    <code>rewriteAppendOnlyFileBackground()</code> runs the child's rewrite inline, then calls{" "}
                    <code>backgroundRewriteDoneHandler()</code> as if the child had exited
                  </>,
                  "There is no fork(); this blocks the server for the rewrite",
                ],
                [
                  "0004-host-aof-rewrite",
                  <>
                    Before rewriting inline, offers the rewrite to the host through the <code>aof_rewrite</code> import;
                    adds the <code>rk_rewrite_done</code> export
                  </>,
                  "The host can write the new base elsewhere while Valkey keeps serving",
                ],
                utc("0005-utc-log-times"),
              ]}
            />
          }
          redis={
            <Table
              headers={PATCH_HEADERS}
              rows={[
                AE,
                MAIN,
                [
                  "0003-aof-rewrite-without-fork",
                  <>
                    Valkey's <code>0003</code> and <code>0004</code> in one: offer the rewrite to the host, otherwise
                    rewrite inline; adds <code>rk_rewrite_done</code>
                  </>,
                  "There is no fork(); the host can write the base while Redis keeps serving",
                ],
                [
                  "0004-no-context-switch-counts",
                  <>
                    The slowlog's CPU sample sets <code>nvcsw</code> and <code>nivcsw</code> to 0
                  </>,
                  "WASI's rusage has no ru_nvcsw or ru_nivcsw",
                ],
                [
                  "0005-import-mode",
                  <>
                    Adds Valkey's <code>import-mode</code> config: no active expiry; writes see expired keys and hash
                    fields as alive, everything else sees them as gone, and nothing deletes them
                  </>,
                  "Read replicas and rewriters run with it, so only the primary's stream deletes keys",
                ],
                utc("0006-utc-log-times"),
              ]}
            />
          }
        />
      </>
    ),
  },
];
