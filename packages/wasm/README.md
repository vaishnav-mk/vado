# @vado/wasm

Builds `valkey.wasm`, Valkey compiled to WebAssembly (WASI preview1, reactor model), from pristine upstream source.
[`redis/`](redis/README.md) builds `redis.wasm` from Redis the same way, with the same shims.

```sh
WASI_SDK=/path/to/wasi-sdk-34.0 packages/wasm/valkey/build.sh   # writes packages/wasm/valkey/build/valkey.wasm
WASI_SDK=/path/to/wasi-sdk-34.0 packages/wasm/redis/build.sh    # writes packages/wasm/redis/build/redis.wasm
```

Needs wasi-sdk 34, binaryen's `wasm-opt` on `PATH`, `curl`, `tar` and `patch`. The script downloads Valkey 9.1.1 into
`packages/wasm/.cache/`, checks the sha256, extracts a fresh tree, applies the patches in order,
compiles Valkey with the shims in `wasi/`, links, and runs `wasm-opt`. Every run starts clean.

| Variable    | Default    | Meaning                                              |
| ----------- | ---------- | ---------------------------------------------------- |
| `WASI_SDK`  | (required) | wasi-sdk install directory                           |
| `OPT`       | `-O3`      | one optimization level, passed to clang and wasm-opt |

## Layout

- `common.sh` holds the steps both builds share: the pinned download and its sha256 check, compiler flags, compile,
  link and `wasm-opt`. `valkey/build.sh` pins the Valkey version and checksum.
- `valkey/patches/` is applied in order:
  - `0001-ae-wasi-backend.patch`: with `HAVE_WASI_AE`, `ae.c` includes `wasi/ae_wasi.c`, a poll backend over the host's
    `poll` import that never blocks.
  - `0002-reactor-main.patch`: `main()` returns after init instead of entering `aeMain`. The host runs the event loop
    through the exports in `wasi/reactor.c`.
  - `0003-inline-aof-rewrite.patch`: there is no `fork()`, so an AOF rewrite runs inline and then finishes the way
    the parent does after the child exits.
  - `0004-host-aof-rewrite.patch`: before rewriting inline, Valkey offers the rewrite to the host (the `aof_rewrite`
    import in `wasi/host.h`), with the temp file's name and a generation (`stat_aof_rewrites`). It offers it only
    while the AOF is on: turning the AOF on opens a temp incr file that isn't in the manifest. If the host takes
    it, Valkey keeps serving with an AOF child marked as running; the host writes the new base to the temp file and
    calls the `rk_rewrite_done(ok, gen)` export, which finishes the rewrite the way the parent does when a child
    exits. If that rewrite isn't running any more (it was killed, and maybe another started), the export returns 0
    and the host removes the file itself. `wasi/wasm_compat.h` makes `waitpid()` return 0, so the child never
    appears to exit by itself, and `kill()` fail with `ESRCH`, so killing the rewrite doesn't wait for a process.
  - `0005-utc-log-times.patch`: log lines in UTC. WASI has no time zones, and Valkey read its offset from a
    `gettimeofday()` argument WASI never fills in, so log dates came out as garbage.
- `wasi/` holds the shims: sockets over host imports (`sock_shim.c`, `host.h`), the reactor exports (`reactor.c`),
  synchronous bio and io-threads plus other missing libc pieces (`valkey/stubs.c`), setjmp/longjmp for Lua (`wasm_sjlj.c`),
  and headers the WASI sysroot lacks. Their comments call the JS side "the bridge"; here that is `packages/server/src/shard/host/`.

## Allocator

The build uses wasi-libc's dlmalloc. zmalloc asks it for `malloc_usable_size` instead of keeping an 8-byte size prefix
per allocation.

A mimalloc build was tried and measured in production with the bench `frag` probe
([measurements](../../docs/measurements.md)): linear memory was 1.6-4.3x Valkey's `used_memory` with mimalloc, against
1.08-1.29x with dlmalloc (flat across rounds of deleting and rewriting half the keys), and it started at 34 MB instead
of 2.6 MB because it allocates in arenas of at least 16 MiB. wasm memory never shrinks, so the option was removed.

## Reproducibility

The downloads are pinned by sha256, the link order uses the C collation, and assertion file names (`__FILE__`) are
relative to the Valkey tree, so the same wasi-sdk and binaryen give the same bytes on any machine.
`valkey/valkey.wasm` is this script's output, and a fresh build reproduces it byte for byte.

Checked with wasi-sdk 34 and binaryen 133 on three hosts: macOS arm64 (wasi-sdk release, Homebrew binaryen), and
Linux arm64 and x86_64 in `ubuntu:24.04` (both projects' release builds). All gave the committed file then;
the current one is 1,940,632 bytes, sha256 `aa27bd1b67b77fd4e8f8ef8fdfe7dd1bf6d6a1c5da92e5d2c9577d047d091da6`.

## Pipeline

`.github/workflows/wasm.yml` runs on pushes and pull requests that touch `packages/wasm/` or the workflow, once for Valkey and once
for Redis (`packages/wasm/redis/`, the same checks against its own files). On ubuntu-latest it installs
wasi-sdk 34 and binaryen `version_133` (sha256-pinned, `.github/actions/wasm-toolchain`), runs `build.sh`, and fails
unless:

- `packages/wasm/valkey/build/valkey.wasm` is byte-identical to the committed `packages/wasm/valkey/valkey.wasm`, and
- its imports and exports match `interface.txt`, the list of what the host (`packages/server/src/shard/host/`) must
  provide and may call. A patch that changes that contract shows up as a diff of names, not only as new bytes.

On failure it prints the interface diff and uploads the build as the `valkey-wasm` artifact.

`interface.mjs` prints the list for a module, or compares it (Node, no dependencies):

```sh
node packages/wasm/interface.mjs [file.wasm] > packages/wasm/valkey/interface.txt   # default file: packages/wasm/valkey/valkey.wasm
node packages/wasm/interface.mjs packages/wasm/valkey/build/valkey.wasm --check packages/wasm/valkey/interface.txt
```

`.github/workflows/valkey-release.yml` runs weekly. If Valkey has a release newer than `build.sh` pins, it runs
`update.sh`, builds, checks the interface, and opens an issue "Valkey X.Y.Z is out" with the results and the size
change. It doesn't commit or open a PR.

To bump Valkey:

```sh
packages/wasm/valkey/update.sh 9.2.0          # rewrites VALKEY_VERSION/VALKEY_SHA256, dry-runs every patch
# fix any patch that fails, against the tree in packages/wasm/.cache/valkey-9.2.0
WASI_SDK=/path/to/wasi-sdk-34.0 packages/wasm/valkey/build.sh
cp packages/wasm/valkey/build/valkey.wasm packages/wasm/valkey/valkey.wasm
node packages/wasm/interface.mjs > packages/wasm/valkey/interface.txt
```

If `interface.txt` changed, update the host to match.

## License

The Valkey build is derived from valkey-wasm and is under its BSD 3-Clause license (`LICENSE`). Valkey is BSD 3-Clause
too. The Redis build is AGPL-3.0 ([`redis/README.md`](redis/README.md)).
