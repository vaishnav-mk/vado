import { Note } from "../components/blocks";
import { ByServer } from "../components/server";
import type { Server } from "./servers";
import type { DocSection } from "./types";
import { PATCHES, patchTotals } from "./wasm-patch-list";
import type { PatchGroup } from "./wasm-patch-list";

const GROUPS: { group: PatchGroup; title: string; text: string }[] = [
  { group: "run", title: "Needed to run at all", text: "no blocking loop, no fork, no missing fields" },
  { group: "both", title: "Needed, with a choice on top", text: "part is needed, part we chose" },
  { group: "chosen", title: "Behaviour we chose", text: "it runs without these" },
];

function PatchCards({ server }: { server: Server }) {
  const largest = Math.max(...PATCHES[server].map((patch) => patch.added + patch.removed));
  const totals = patchTotals(server);
  const groups = GROUPS.filter(({ group }) => PATCHES[server].some((patch) => patch.group === group));

  return (
    <>
      <p>
        {totals.count} patches, {totals.changed} changed lines in all ({totals.added} added, {totals.removed} removed).
      </p>
      {groups.map(({ group, title, text }) => (
        <div key={group}>
          <h3 className="patch-group-title">
            {title} <span>{text}</span>
          </h3>
          <div className="patch-list">
            {PATCHES[server]
              .filter((patch) => patch.group === group)
              .map((patch) => {
                const lines = patch.added + patch.removed;

                return (
                  <article className="patch" key={patch.file}>
                    <div className="patch-head">
                      <code>{patch.file}</code>
                      <span className="patch-size" title={`${patch.added} added, ${patch.removed} removed`}>
                        <i style={{ width: `${Math.round((lines / largest) * 64)}px` }} aria-hidden="true" />
                        {patch.removed > 0 ? `+${patch.added} -${patch.removed}` : `+${patch.added}`}
                      </span>
                    </div>
                    <dl>
                      <dt>what</dt>
                      <dd>{patch.what}</dd>
                      <dt>why</dt>
                      <dd>{patch.why}</dd>
                    </dl>
                  </article>
                );
              })}
          </div>
        </div>
      ))}
    </>
  );
}

export const PATCH_SECTIONS: DocSection[] = [
  {
    id: "patches",
    title: "What we change",
    content: (
      <>
        <p>
          Plain unified diffs against the release tree, in{" "}
          <ByServer
            valkey={<code>packages/wasm/valkey/patches/</code>}
            redis={<code>packages/wasm/redis/patches/</code>}
          />
          . What the sandbox needs sits under <code>#ifdef VALKEY_WASM</code> or <code>HAVE_WASI_AE</code>. Redis's{" "}
          <code>import-mode</code> is the one feature added outright.
        </p>
        <ByServer valkey={<PatchCards server="valkey" />} redis={<PatchCards server="redis" />} />
        <Note title="Patches are line-sensitive">
          <p>
            <code>build.sh</code> applies them with <code>patch -p1 -F0</code>: zero fuzz. A patch whose context moved
            fails the build instead of landing somewhere close.
          </p>
        </Note>
      </>
    ),
  },
  {
    id: "adds",
    title: "What we add",
    content: (
      <>
        <p>
          Shared C in <code>packages/wasm/wasi/</code>, compiled into both builds:
        </p>
        <ul>
          <li>
            <code>reactor.c</code>: the <code>rk_*</code> exports the host calls.
          </li>
          <li>
            <code>ae_wasi.c</code>: the event loop backend over <code>host.poll</code>, tracking only fds with a nonzero
            mask.
          </li>
          <li>
            <code>sock_shim.c</code>: <code>socket()</code>, <code>listen()</code>, <code>accept()</code>,{" "}
            <code>getaddrinfo()</code> and the wrapped <code>read</code>, <code>write</code>, <code>writev</code>,{" "}
            <code>close</code> and <code>fcntl</code>.
          </li>
          <li>
            <code>host.h</code>: declarations of the host imports.
          </li>
          <li>
            <code>wasm_compat.h</code>, forced into every file: macros and types for what the sandbox lacks, and missing
            errno and socket constants.
          </li>
          <li>
            <code>wasm_sjlj.c</code>: the setjmp and longjmp helpers LLVM's lowering calls. wasi-sdk doesn't ship them.
          </li>
          <li>
            <code>grp.h</code>, <code>netdb.h</code>, <code>syslog.h</code>, <code>termios.h</code>,{" "}
            <code>sys/un.h</code>, <code>sys/wait.h</code>: headers the sysroot lacks or leaves incomplete.
          </li>
        </ul>
        <ByServer
          valkey={
            <p>
              Valkey's <code>stubs.c</code> also answers <code>dlopen(NULL)</code> and{" "}
              <code>dlsym("ValkeyModule_OnLoad_lua")</code>, so the static Lua engine module loads.
            </p>
          }
          redis={
            <p>
              Redis also gets <code>redis/include/module.h</code>, which stands in for Valkey's <code>module.h</code>{" "}
              that the shared <code>reactor.c</code> includes.
            </p>
          }
        />
      </>
    ),
  },
  {
    id: "turned-off",
    title: "What we turn off",
    content: (
      <>
        <p>
          Some come from <code>wasm_compat.h</code>, the rest from the server's <code>stubs.c</code>, which stands in
          for the objects the build leaves out.
        </p>
        <ul>
          <li>
            <strong>fork</strong>: <code>fork()</code> and <code>wait3()</code> return -1, <code>waitpid()</code>{" "}
            returns 0, <code>kill()</code> fails with <code>ESRCH</code>. Anything that forks fails as a failed fork
            would.
          </li>
          <li>
            <strong>Background threads</strong>: bio isn't built. Its jobs (closes, fsyncs, lazy frees) run inline when
            submitted. Closing an old AOF file fsyncs it first, as bio's job does.
            <ByServer
              valkey=""
              redis=" A job's completion callback runs on the next pass, so it never unblocks a client from inside that client's own command."
            />
          </li>
          <li>
            <strong>I/O threads</strong>:{" "}
            <ByServer
              valkey="io_threads and threads_mngr aren't built, and every offload fails, so the caller does the work. The"
              redis="the"
            />{" "}
            shard boots with <code>--io-threads 1</code>.
          </li>
          <li>
            <strong>TLS</strong>
            <ByServer valkey=" and RDMA" redis="" />: not built, and registering the connection type fails.
          </li>
          <li>
            <strong>dlopen</strong>: no shared objects.
          </li>
          <li>
            <strong>Backtraces</strong>: <code>backtrace()</code> and <code>dladdr()</code> find nothing.
          </li>
          <li>
            <strong>Signals, timers, rlimits</strong>: no-ops. <code>getrlimit()</code> reports a generous fd limit.
          </li>
          <li>
            <strong>Sentinel's async client</strong>: <ByServer valkey="libvalkey" redis="hiredis" /> isn't built, and
            sentinel mode never runs.
          </li>
        </ul>
      </>
    ),
  },
];
