import { Facts, Note } from "../components/blocks";
import { DocLink } from "../components/doc-link";
import { ByServer } from "../components/server";
import type { DocSection } from "./types";

export const BOUNDARY_SECTIONS: DocSection[] = [
  {
    id: "imports",
    title: "What the host provides",
    content: (
      <>
        <p>
          <code>interface.txt</code> in each build directory lists every import and export, sorted, as printed by{" "}
          <code>packages/wasm/interface.mjs</code>. It is the contract with the host in{" "}
          <code>packages/server/src/wasm-shard/host/</code>.
        </p>
        <Note title="A missing import fails instantiation">
          <p>
            The host must provide every import the module lists, or the shard can't create its instance. Change the host
            and both <code>interface.txt</code> files together.
          </p>
        </Note>
        <Facts
          items={[
            [
              <code>host.socket, listen, accept, read, write, close, poll</code>,
              <>
                Sockets, in <code>sockets.ts</code> (<a href="#sockets">below</a>)
              </>,
            ],
            [
              <code>host.aof_rewrite</code>,
              <>
                <code>aof-rewrite.ts</code>: gives the rewrite to the shard's <code>onRewrite</code> hook, or returns 0
              </>,
            ],
            [<code>env.__c_longjmp</code>, "A WebAssembly.Tag the host creates, for Lua's longjmp"],
            [
              <>
                <code>fd_*</code>, <code>path_*</code>
              </>,
              <>
                Files, in <code>wasm-shard/vfs</code>: a file system in the object's SQLite, with one preopened
                directory, <code>/data</code>
              </>,
            ],
            [<code>fd_write</code>, "On fds 1 and 2: lines go to the shard's log"],
            [<code>clock_time_get</code>, "Date.now() for every clock, cached per millisecond"],
            [<code>poll_oneoff, sched_yield</code>, "Return at once: nothing sleeps"],
            [<code>environ_*</code>, "An empty environment"],
            [<code>proc_exit</code>, "Throws. During a pass, that resets the shard"],
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
        <h3>Files and the clock</h3>
        <ul>
          <li>
            AOF appends reach SQLite synchronously, by the write or the fsync after it. A reply leaves only after the
            bytes behind it are durable (<DocLink slug="durability">Durability</DocLink>).
          </li>
          <li>Other files buffer until fsync or close.</li>
          <li>A file is rows of at most 1 MB. Deleted files' rows are swept in the background.</li>
          <li>
            A Workers clock moves only across I/O, so during one event loop pass the server sees time stand still.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "sockets",
    title: "Sockets",
    content: (
      <>
        <p>
          wasi-libc has no sockets, so <code>sock_shim.c</code> defines them over the <code>host</code> imports.
        </p>
        <ul>
          <li>
            The host owns the fd numbers. Every host socket is at or above 4096, below the event loop's set size, and{" "}
            <code>socket()</code> asks the host for one.
          </li>
          <li>
            <code>bind()</code> records the port, <code>listen()</code> tells the host which fd is the listener, and{" "}
            <code>accept()</code> takes the next client fd the host queued.
          </li>
          <li>
            Name lookups always answer 127.0.0.1, and <code>connect()</code> fails with <code>ECONNREFUSED</code>. No
            outgoing connection is ever made.
          </li>
          <li>
            The wrapped <code>read</code>, <code>write</code>, <code>writev</code>, <code>close</code> and{" "}
            <code>fcntl</code> send host fds to the host and everything else to wasi-libc.
          </li>
          <li>
            <code>writev</code> is split into one <code>host.write</code> per buffer. Replies over 16 KB use it.
          </li>
          <li>
            <code>pipe()</code> hands out fds from 3072 that never have data, for the module pipe the server must
            create.
          </li>
          <li>
            The host reports a socket readable when it has buffered input or hit EOF, and always writable. It applies
            backpressure by pausing input instead.
          </li>
        </ul>
      </>
    ),
  },
];
