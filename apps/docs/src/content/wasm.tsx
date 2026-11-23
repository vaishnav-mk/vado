import { CpuIcon } from "@phosphor-icons/react";
import { Code, Table } from "../components/blocks";
import { ByServer, ServerBadge } from "../components/server";
import { SERVERS } from "./servers";
import { server, source } from "./sources";
import type { Doc } from "./types";
import { BOUNDARY_SECTIONS } from "./wasm-boundary";
import { RUNTIME_SECTIONS } from "./wasm-runtime";
import { CHANGE_SECTIONS } from "./wasm-changes";

const flag = (text: string) => <code className="whitespace-nowrap">{text}</code>;

export const wasm: Doc = {
  slug: "wasm",
  title: "WebAssembly builds",
  group: "How it works",
  icon: CpuIcon,
  description:
    "How packages/wasm turns a pinned Valkey or Redis release into a WASI reactor module, what each patch changes, what the module imports from the host, and how to change or upgrade a build.",
  keywords:
    "wasm webassembly wasi wasi-sdk binaryen wasm-opt build.sh common.sh update.sh patches reactor interface.txt dlmalloc sock_shim host imports fork aof rewrite reproducible",
  intro: (
    <p>
      Both builds share one toolchain, one set of shims in <code>packages/wasm/wasi/</code> and one host. Where they
      differ, the page follows the server picked in the header: <ServerBadge />.
    </p>
  ),
  sections: [
    {
      id: "toolchain",
      title: "Toolchain",
      content: (
        <>
          <Code label="Needs wasi-sdk 34, binaryen's wasm-opt on PATH, curl, tar and patch">
            {
              "WASI_SDK=/path/to/wasi-sdk-34.0 packages/wasm/valkey/build.sh\nWASI_SDK=/path/to/wasi-sdk-34.0 packages/wasm/redis/build.sh"
            }
          </Code>
          <p>
            The compiler is wasi-sdk 34's clang with its wasi-libc sysroot, targeting <code>wasm32-wasip1</code>.{" "}
            <code>OPT</code> (default <code>-O3</code>) is passed to both clang and <code>wasm-opt</code>. Every run
            starts from a freshly extracted tree and writes <code>build/valkey.wasm</code> or{" "}
            <code>build/redis.wasm</code> next to its script; only the tarballs in <code>packages/wasm/.cache/</code>{" "}
            are reused.
          </p>
          <p>
            The output is reproducible: downloads are pinned by sha256, <code>LC_ALL=C</code> fixes the order of the
            link's <code>obj/*.o</code> glob, and <code>-ffile-prefix-map</code> makes assertion file names relative to
            the source tree. CI installs wasi-sdk 34 and binaryen <code>version_133</code>, both checked by sha256, and
            fails unless its build is byte-identical to the committed wasm. Other toolchain versions give other bytes.
          </p>
          <Table
            headers={["Build", "Valkey", "Redis"]}
            rows={[
              ["Upstream", SERVERS.valkey.version, SERVERS.redis.version],
              ["Committed module", "packages/wasm/valkey/valkey.wasm", "packages/wasm/redis/redis.wasm"],
              ["Size", SERVERS.valkey.wasm, SERVERS.redis.wasm],
              ["Licence", SERVERS.valkey.licence, SERVERS.redis.licence],
            ]}
          />
        </>
      ),
    },
    {
      id: "build",
      title: "What build.sh does",
      content: (
        <>
          <p>
            Each server's <code>build.sh</code> sources <code>packages/wasm/common.sh</code>, which holds the shared
            steps, then runs them with its own pins and file lists:
          </p>
          <ol>
            <li>
              <code>fetch</code> downloads the release tarball from GitHub once, checks its sha256 against the one
              pinned in <code>build.sh</code>, extracts a fresh tree into <code>.cache/</code>, and applies{" "}
              <code>patches/*.patch</code> in name order with <code>patch -p1 -F0</code>. Zero fuzz: a patch whose
              context changed fails instead of landing somewhere close.
            </li>
            <li>
              It writes <code>src/release.h</code>, which upstream's Makefile generates from git metadata a tarball
              lacks.
            </li>
            <li>It compiles Lua and the small dependencies, then the server's own objects.</li>
            <li>
              <code>link</code> compiles the shared shims and the server's <code>stubs.c</code>, links everything into a
              reactor module, and runs <code>wasm-opt -g --strip-dwarf $OPT</code>: it optimizes again at the same
              level, drops DWARF, and keeps the name section so a trap's stack trace shows function names.
            </li>
          </ol>
          <ByServer
            valkey={
              <p>
                Valkey's object list is read from <code>ENGINE_SERVER_OBJ</code> and <code>ENGINE_TRACE_OBJ</code> in
                its <code>src/Makefile</code>, minus <code>bio</code>, <code>io_threads</code> and{" "}
                <code>threads_mngr</code> (they need threads; <code>stubs.c</code> runs their API inline) and{" "}
                <code>tls</code> and <code>rdma</code> (unused, and they crash this LLVM's code generation). The Lua
                engine is a static module in <code>src/modules/lua</code>, built with <code>LUA_ENABLED</code> and{" "}
                <code>STATIC_LUA</code>; its API pointers use <code>__attribute__((__common__))</code>, which this LLVM
                can't emit for wasm, so they're compiled as weak globals. <code>stubs.c</code> answers{" "}
                <code>dlopen(NULL)</code> and <code>dlsym("ValkeyModule_OnLoad_lua")</code> so the module loads.
              </p>
            }
            redis={
              <p>
                Redis's object list is <code>REDIS_SERVER_OBJ</code> in its <code>src/Makefile</code>, minus{" "}
                <code>bio</code> (it starts threads; <code>stubs.c</code> runs its jobs inline) and <code>tls</code>.
                Besides Lua, fpconv and hdr_histogram, it compiles xxhash, the tre regex library and CRoaring (with its
                x64 and NEON code paths off). <code>redis/include/module.h</code> stands in for Valkey's{" "}
                <code>module.h</code>, which the shared <code>reactor.c</code> includes.
              </p>
            }
          />
        </>
      ),
    },
    {
      id: "flags",
      title: "Compiler and linker flags",
      content: (
        <Table
          headers={["Flag", "Why"]}
          rows={[
            [
              <>
                {flag("-D_WASI_EMULATED_*")}, {flag("-lwasi-emulated-*")}
              </>,
              "wasi-libc's emulated signal(), process clocks, mmap and getpid",
            ],
            [
              <>
                {flag("-DVALKEY_WASM=1")} {flag("-DHAVE_WASI_AE=1")}
              </>,
              "Turn on the patches and shims; Redis is built with the same names",
            ],
            [
              flag("-DUSE_MALLOC_USABLE_SIZE"),
              "zmalloc asks the allocator for sizes instead of keeping a prefix per block",
            ],
            [flag("-include wasm_compat.h"), "Forced into every file: macros and types for what the sandbox lacks"],
            [
              <>{flag("-Wno-implicit-function-declaration")} and four more</>,
              "Let the upstream sources compile against the sysroot",
            ],
            [flag("-mexec-model=reactor"), "Build a reactor: no _start, an _initialize export instead"],
            [
              flag("-lc-printscan-long-double"),
              "The default printf and strtold trap on long double, which INCRBYFLOAT and scores parse",
            ],
            [flag("-Wl,--allow-undefined"), "The host imports resolve when the module is instantiated"],
            [
              <>{flag("-Wl,--wrap=read")} and the same for write, writev, close and fcntl</>,
              "Route those calls through sock_shim.c, which sends host fds to the host",
            ],
            [flag("-Wl,-z,stack-size=1048576"), "A 1 MB stack"],
            [flag("-mllvm -wasm-enable-sjlj"), "For Lua and wasm_sjlj.c: setjmp and longjmp become wasm exceptions"],
          ]}
        />
      ),
    },
    ...RUNTIME_SECTIONS,
    ...BOUNDARY_SECTIONS,
    ...CHANGE_SECTIONS,
  ],
  sources: [
    source("packages/wasm/common.sh"),
    source("packages/wasm/valkey/build.sh"),
    source("packages/wasm/redis/build.sh"),
    source("packages/wasm/valkey/update.sh"),
    source("packages/wasm/wasi"),
    source("packages/wasm/interface.mjs"),
    server("shard/host/valkey-host.ts"),
    server("shard/host/wasi.ts"),
    server("shard/host/sockets.ts"),
    server("shard/vfs/vfs.ts"),
    source(".github/workflows/wasm.yml"),
  ],
};
