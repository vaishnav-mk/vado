import { Table } from "../components/blocks";
import { DocLink } from "../components/doc-link";
import { ByServer } from "../components/server";
import type { DocSection } from "./types";

export const BOUNDARY_SECTIONS: DocSection[] = [
  {
    id: "imports",
    title: "What the module imports",
    content: (
      <>
        <p>
          <code>interface.txt</code> in each build directory lists every import and export, sorted, as printed by{" "}
          <code>packages/wasm/interface.mjs</code>. It is the contract with the host in{" "}
          <code>packages/server/src/shard/host/</code>: instantiation fails if an import is missing.
        </p>
        <Table
          headers={["Imports", "Host side"]}
          rows={[
            [<code>host.socket, listen, accept, read, write, close, poll</code>, "Sockets in sockets.ts (below)"],
            [
              <code>host.aof_rewrite</code>,
              "aof-rewrite.ts: gives the rewrite to the shard's onRewrite hook, or returns 0",
            ],
            [<code>env.__c_longjmp</code>, "A WebAssembly.Tag the host creates, for Lua's longjmp"],
            [
              <>
                <code>fd_*</code>, <code>path_*</code> (files)
              </>,
              "shard/vfs: a file system in the object's SQLite, with one preopened directory, /data",
            ],
            [
              <>
                <code>fd_write</code> on fds 1 and 2
              </>,
              "Lines go to the shard's log",
            ],
            [<code>clock_time_get</code>, "Date.now() for every clock, cached per millisecond"],
            [<code>poll_oneoff, sched_yield</code>, "Return at once: nothing sleeps"],
            [<code>environ_*</code>, "An empty environment"],
            [<code>proc_exit</code>, "Throws; during a pass, that resets the shard"],
            [<code>sock_shutdown, path_link, path_readlink</code>, "ENOSYS"],
          ]}
        />
        <ByServer
          valkey={
            <p>
              Valkey also imports <code>sched_yield</code>, which Redis doesn't.
            </p>
          }
          redis={
            <p>
              Redis also imports <code>path_link</code> and <code>path_readlink</code>, and not <code>sched_yield</code>
              . It calls <code>link()</code> when installing a preloaded AOF and falls back to copying when that fails.
            </p>
          }
        />
        <p>
          Files: AOF appends reach SQLite synchronously, by the write or the fsync after it, so a reply leaves only
          after the bytes behind it are durable (<DocLink slug="durability">Durability</DocLink>). Other files buffer
          until fsync or close. A file is rows of at most 1 MB, and deleted files' rows are swept in the background. The
          clock matters because a Workers clock moves only across I/O: during one event loop pass, the server sees time
          stand still.
        </p>
      </>
    ),
  },
  {
    id: "sockets",
    title: "Sockets",
    content: (
      <>
        <p>
          wasi-libc has no sockets, so <code>sock_shim.c</code> defines them over the <code>host</code> imports. The
          host owns the fd numbers: every host socket is at or above 4096, below the event loop's set size, and{" "}
          <code>socket()</code> asks the host for one. <code>bind()</code> records the port, <code>listen()</code> tells
          the host which fd is the listener, and <code>accept()</code> takes the next client fd the host queued. Name
          lookups always answer 127.0.0.1, and <code>connect()</code> fails with <code>ECONNREFUSED</code>, so no
          outgoing connection is ever made.
        </p>
        <p>
          The wrapped <code>read</code>, <code>write</code>, <code>writev</code>, <code>close</code> and{" "}
          <code>fcntl</code> send host fds to the host and everything else to wasi-libc. <code>writev</code> is split
          into one <code>host.write</code> per buffer; replies over 16 KB use it. <code>pipe()</code> hands out fds from
          3072 that never have data, for the module pipe the server must create. The host reports a socket readable when
          it has buffered input or hit EOF, and always writable; it applies backpressure by pausing input instead.
        </p>
      </>
    ),
  },
  {
    id: "no-fork",
    title: "No threads, no fork",
    content: (
      <>
        <p>
          The module is single-threaded. Background I/O jobs (closes, fsyncs, lazy frees) run inline when they're
          submitted, and the server boots with <code>--io-threads 1</code>.{" "}
          <ByServer
            valkey=""
            redis={
              <>
                Redis runs a job's completion callback on the next pass, so it never unblocks a client from inside that
                client's own command.{" "}
              </>
            }
          />
          <code>rk_tick</code> leaves the module GIL released before each pass, since locking a held mutex would trap.{" "}
          <code>fork()</code> is a macro for -1, so anything that forks fails as a failed fork would; the shard runs
          with <code>--save ""</code> and <code>--auto-aof-rewrite-percentage 0</code>.
        </p>
        <p>An AOF rewrite, started by the shard with BGREWRITEAOF, goes like this instead:</p>
        <ol>
          <li>
            The server opens a new incremental file as before a fork, then calls <code>host.aof_rewrite</code> with the
            temp file's name, whether to write RDB, and a generation number. It asks only while the AOF is on: turning
            the AOF on opens a temp incremental file that isn't in the manifest.
          </li>
          <li>
            If the host returns 1, the server keeps serving with an AOF child marked as running. The host has a rewriter
            object rebuild the base from the files before the new incremental file, and writes it to{" "}
            <code>tmpfile</code>.
          </li>
          <li>
            The host calls <code>rk_rewrite_done(ok, generation)</code>, which finishes the rewrite as the parent does
            when a child exits. It returns 0 if that rewrite was killed meanwhile, and the host deletes the file.
          </li>
          <li>If the host returns 0, the server rewrites inline and blocks until done.</li>
        </ol>
        <p>
          <code>waitpid()</code> always returns 0, so the fake child never seems to exit on its own, and{" "}
          <code>kill()</code> fails with <code>ESRCH</code>, so killing a rewrite doesn't wait for a process.
        </p>
      </>
    ),
  },
];
