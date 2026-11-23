import { Note, Steps } from "../components/blocks";
import { RewriteSequence } from "../components/diagrams/wasm-rewrite";
import { DocLink } from "../components/doc-link";
import { ServerName } from "../components/server";
import type { DocSection } from "./types";

export const REACTOR_SECTIONS: DocSection[] = [
  {
    id: "reactor",
    title: "How it runs: the reactor model",
    content: (
      <>
        <p>
          A Durable Object runs the module on the same thread as its event loop, so the server can never block in{" "}
          <code>aeMain</code>. Instead the host drives the event loop one non-blocking pass at a time. All server state
          stays in the instance's linear memory between calls.
        </p>
        <Steps
          items={[
            <>
              <strong>Instantiate</strong> the module with its imports. <code>_initialize</code> runs once: wasi-libc's
              constructors.
            </>,
            <>
              <strong>Boot.</strong> The host writes NUL-separated arguments into an 8 KB buffer (
              <code>rk_args_ptr</code>, <code>rk_args_cap</code>) and calls <code>rk_boot_args</code>. Init loads the
              AOF, and <code>main()</code> returns instead of entering <code>aeMain</code> (patch <code>0002</code>).
            </>,
            <>
              <strong>Set the timer.</strong> <code>rk_next_timeout_ms</code> is <code>1000 / hz</code>, the serverCron
              period. The host's timer uses it, at least 20 ms, and runs only while clients are connected.
            </>,
            <>
              <strong>Tick.</strong> On socket input or the timer, the host calls <code>rk_tick</code>: one pass in{" "}
              <code>aeMain</code>'s order (afterSleep, events, timers, beforeSleep), so the AOF write and the reply
              flush happen in the same call.
            </>,
            <>
              <strong>Finish rewrites.</strong> <code>rk_rewrite_done</code> ends an AOF rewrite the host took (
              <a href="#aof-rewrite">below</a>).
            </>,
          ]}
        />
        <ul>
          <li>
            The host reads and writes <code>memory</code> directly (with <code>__stack_pointer</code> exported too), so
            no copy exports are needed.
          </li>
          <li>
            <code>reactor.c</code> also exports <code>rk_boot</code> (a fixed argument list) and <code>rk_step</code> (a
            pass that runs beforeSleep first). The host uses neither.
          </li>
        </ul>
        <Note>
          <p>
            The allocator is wasi-libc's dlmalloc. Linear memory never shrinks, and with dlmalloc it measured 1.08 to
            1.29 times Valkey's <code>used_memory</code>. A mimalloc build measured 1.6 to 4.3 times (
            <DocLink slug="measurements" hash="memory">
              measurements
            </DocLink>
            ).
          </p>
        </Note>
      </>
    ),
  },
];

export const FORK_SECTIONS: DocSection[] = [
  {
    id: "no-fork",
    title: "One thread, no fork",
    content: (
      <ul>
        <li>The module is single-threaded. Background jobs run inline (see what we turn off, above).</li>
        <li>
          <code>rk_tick</code> leaves the module GIL released before each pass. Boot leaves it held, and locking a held
          mutex traps without threads.
        </li>
        <li>
          <code>fork()</code> is a macro for -1, and the shard runs with <code>--save ""</code> and{" "}
          <code>--auto-aof-rewrite-percentage 0</code>.
        </li>
        <li>
          <code>waitpid()</code> always returns 0, so the fake rewrite child never seems to exit on its own.{" "}
          <code>kill()</code> fails with <code>ESRCH</code>, so killing a rewrite doesn't wait for a process.
        </li>
      </ul>
    ),
  },
  {
    id: "aof-rewrite",
    title: "An AOF rewrite without fork",
    content: (
      <>
        <p>
          Upstream forks a child to write the new base file. Here the shard starts the rewrite with BGREWRITEAOF, and{" "}
          <ServerName /> offers it to the host through the <code>aof_rewrite</code> import:
        </p>
        <RewriteSequence />
        <ul>
          <li>
            <ServerName /> asks only while the AOF is on: turning the AOF on opens a temp incremental file that isn't in
            the manifest, so the files before it aren't the whole data.
          </li>
          <li>
            On the host side, <code>aof-rewrite.ts</code> gives the rewrite to the shard's <code>onRewrite</code> hook,
            and returns 0 when a rewrite is already running or the hook doesn't take it.
          </li>
          <li>
            <code>rk_rewrite_done</code> finishes it the way the parent does when a child exits:{" "}
            <code>backgroundRewriteDoneHandler()</code>, then <code>resetChildState()</code>.
          </li>
        </ul>
      </>
    ),
  },
];
