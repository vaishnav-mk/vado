import { Code, Facts, Note, Steps } from "../components/blocks";
import { ByServer } from "../components/server";
import type { DocSection } from "./types";

const flag = (text: string) => <code className="whitespace-nowrap">{text}</code>;

export const BUILD_SECTIONS: DocSection[] = [
  {
    id: "build",
    title: "Building it",
    content: (
      <>
        <Code label="Needs wasi-sdk 34, binaryen's wasm-opt on PATH, curl, tar and patch">
          {
            "WASI_SDK=/path/to/wasi-sdk-34.0 packages/wasm/valkey/build.sh\nWASI_SDK=/path/to/wasi-sdk-34.0 packages/wasm/redis/build.sh"
          }
        </Code>
        <ul>
          <li>
            The compiler is wasi-sdk 34's clang with its wasi-libc sysroot, targeting <code>wasm32-wasip1</code>.
          </li>
          <li>
            <code>OPT</code> (default <code>-O3</code>) is passed to both clang and <code>wasm-opt</code>.
          </li>
          <li>
            Every run starts from a freshly extracted tree and writes <code>build/valkey.wasm</code> or{" "}
            <code>build/redis.wasm</code> next to its script. Only the tarballs in <code>packages/wasm/.cache/</code>{" "}
            are reused.
          </li>
        </ul>
        <Note title="Builds must be byte-identical">
          <p>
            CI installs wasi-sdk 34 and binaryen <code>version_133</code>, both checked by sha256, and fails unless its
            build matches the committed wasm byte for byte. Other toolchain versions give other bytes.
          </p>
        </Note>
        <p>What keeps the output reproducible:</p>
        <ul>
          <li>Downloads are pinned by sha256.</li>
          <li>
            <code>LC_ALL=C</code> fixes the order of the link's <code>obj/*.o</code> glob.
          </li>
          <li>
            <code>-ffile-prefix-map</code> makes assertion file names relative to the source tree.
          </li>
        </ul>
        <h3>What build.sh does</h3>
        <p>
          Each server's <code>build.sh</code> sources <code>packages/wasm/common.sh</code>, which holds the shared
          steps, then runs them with its own pins and file lists:
        </p>
        <Steps
          items={[
            <>
              <code>fetch</code> downloads the release tarball from GitHub once, checks its sha256 against the one
              pinned in <code>build.sh</code>, extracts a fresh tree into <code>.cache/</code>, and applies{" "}
              <code>patches/*.patch</code> in name order with <code>patch -p1 -F0</code>.
            </>,
            <>
              It writes <code>src/release.h</code>, which upstream's Makefile generates from git metadata a tarball
              lacks.
            </>,
            <>It compiles Lua and the small dependencies, then the server's own objects.</>,
            <>
              <code>link</code> compiles the shared shims and the server's <code>stubs.c</code>, and links everything
              into a reactor module.
            </>,
            <>
              <code>wasm-opt -g --strip-dwarf $OPT</code> optimizes again at the same level, drops DWARF, and keeps the
              name section, so a trap's stack trace shows function names.
            </>,
          ]}
        />
        <ByServer
          valkey={
            <ul>
              <li>
                The object list comes from <code>ENGINE_SERVER_OBJ</code> and <code>ENGINE_TRACE_OBJ</code> in{" "}
                <code>src/Makefile</code>.
              </li>
              <li>
                Left out: <code>bio</code>, <code>io_threads</code> and <code>threads_mngr</code> (they need threads;{" "}
                <code>stubs.c</code> runs their API inline), and <code>tls</code> and <code>rdma</code> (unused, and
                they crash this LLVM's code generation).
              </li>
              <li>
                The Lua engine is a static module in <code>src/modules/lua</code>, built with <code>LUA_ENABLED</code>{" "}
                and <code>STATIC_LUA</code>.
              </li>
              <li>
                Its API pointers use <code>__attribute__((__common__))</code>, which this LLVM can't emit for wasm, so
                they're compiled as weak globals.
              </li>
            </ul>
          }
          redis={
            <ul>
              <li>
                The object list is <code>REDIS_SERVER_OBJ</code> in <code>src/Makefile</code>, minus <code>bio</code>{" "}
                (it starts threads; <code>stubs.c</code> runs its jobs inline) and <code>tls</code>.
              </li>
              <li>
                Besides Lua, fpconv and hdr_histogram, it compiles xxhash, the tre regex library and CRoaring, with
                CRoaring's x64 and NEON code paths off.
              </li>
            </ul>
          }
        />
      </>
    ),
  },
  {
    id: "flags",
    title: "Compiler and linker flags",
    content: (
      <Facts
        items={[
          [
            <>
              {flag("-D_WASI_EMULATED_*")} {flag("-lwasi-emulated-*")}
            </>,
            "wasi-libc's emulated signal(), process clocks, mmap and getpid",
          ],
          [
            <>
              {flag("-DVALKEY_WASM=1")} {flag("-DHAVE_WASI_AE=1")}
            </>,
            "Turn on the patches and shims. Redis is built with the same names",
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
];
