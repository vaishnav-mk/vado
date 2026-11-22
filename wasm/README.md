# wasm/

Builds `valkey.wasm`, Valkey compiled to WebAssembly (WASI preview1, reactor model), from pristine upstream source.

```sh
WASI_SDK=/path/to/wasi-sdk-34.0 wasm/build.sh                      # writes wasm/build/valkey.wasm
WASI_SDK=/path/to/wasi-sdk-34.0 ALLOCATOR=mimalloc wasm/build.sh
```

Needs wasi-sdk 34, binaryen's `wasm-opt` on `PATH`, `curl`, `tar` and `patch`. The script downloads Valkey 9.1.1 (and
mimalloc, if selected) into `wasm/.cache/`, checks the sha256, extracts a fresh tree, applies the patches in order,
compiles Valkey with the shims in `wasi/`, links, and runs `wasm-opt`. Every run starts clean.

| Variable    | Default    | Meaning                                              |
| ----------- | ---------- | ---------------------------------------------------- |
| `WASI_SDK`  | (required) | wasi-sdk install directory                           |
| `ALLOCATOR` | `libc`     | `libc` or `mimalloc`                                 |
| `OPT`       | `-O3`      | one optimization level, passed to clang and wasm-opt |

## Layout

- `build.sh` pins the Valkey and mimalloc versions and their checksums.
- `patches/` is applied to every build:
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
- `patches/mimalloc/` is applied only with `ALLOCATOR=mimalloc`:
  - `0001-zmalloc-mimalloc.patch`: a `USE_MIMALLOC` branch in zmalloc. It calls `mi_malloc`, `mi_calloc`,
    `mi_realloc` and `mi_free`, sizes blocks with `mi_usable_size`, and INFO shows `mem_allocator:mimalloc-3.7.0`.
- `wasi/` holds the shims: sockets over host imports (`sock_shim.c`, `host.h`), the reactor exports (`reactor.c`),
  synchronous bio and io-threads plus other missing libc pieces (`stubs.c`), setjmp/longjmp for Lua (`wasm_sjlj.c`),
  and headers the WASI sysroot lacks. Their comments call the JS side "the bridge"; here that is `src/shard/valkey-host.js`.

## Allocators

`libc` uses wasi-libc's dlmalloc. zmalloc asks it for `malloc_usable_size` instead of keeping an 8-byte size prefix
per allocation. `wasm/valkey.wasm` is this build.

`mimalloc` links mimalloc 3.7.0 as one object (`src/static.c`) built with `MI_MALLOC_OVERRIDE`, so it also defines
`malloc`, `free`, `calloc`, `realloc`, `posix_memalign`, `aligned_alloc`, `malloc_usable_size` and the `__libc_*`
entry points. wasi-libc's dlmalloc is never linked: Lua (which allocates with `realloc` and `free`), libc and Valkey
share one heap, and only mimalloc grows linear memory. It is built with:

- `MI_SECURE=0 MI_DEBUG=0 MI_STATS=0 MI_PADDING=0 MI_GUARDED=0 MI_PROFILE=0`: no hardening, assertions, statistics,
  block padding, guard pages or sampling. (3.x spells `MI_STAT` as `MI_STATS`.)
- `MI_DEFAULT_ARENA_RESERVE=65536` (KiB). mimalloc grows memory an arena at a time. wasm can't reserve address space
  without committing it, so mimalloc takes a quarter of this value, and a wasm32 arena is at least 16 MiB (256 slices
  of 64 KiB). The default would give 32 MiB arenas, which can overshoot a 64 to 96 MB heap by up to 32 MiB; this
  gives 16 MiB. Smaller arenas would need a different bitmap geometry (`MI_BCHUNK_BITS_SHIFT`), less tested on
  32-bit.

The mimalloc build adds one import, `wasi_snapshot_preview1.random_get` (it seeds mimalloc's keys), which the host
provides. Its exports match the libc build's.

What to watch when trying it:

- Linear memory starts larger, since allocations come from arenas of at least 16 MiB: 34 MB at boot in production,
  against 2.6 MB with dlmalloc.
- wasm memory never shrinks. Freed arena space is reused, but an allocation that fits no arena reserves a new one of
  its size plus up to 16 MiB: a 20 MiB hashtable resize that misses gets a 48 MiB arena.
- `mi_usable_size` returns the whole size-class block (classes are 12.5% apart), and zmalloc counts that, so
  `used_memory` and maxmemory accounting read higher than with dlmalloc for the same data. Partly empty pages aren't
  counted at all; the real footprint is the wasm memory size.

Measured in production with the bench `frag` probe ([measurements](../docs/measurements.md)), linear memory was
1.08-1.29x Valkey's `used_memory` with dlmalloc, flat across rounds of deleting and rewriting half the keys, and
1.6-4.3x with mimalloc. So `wasm/valkey.wasm` stays on dlmalloc.

## Reproducibility

The downloads are pinned by sha256, the link order uses the C collation, and assertion file names (`__FILE__`) are
relative to the Valkey tree, so the same wasi-sdk and binaryen give the same bytes on any machine.
`wasm/valkey.wasm` is this script's `ALLOCATOR=libc` output, and a fresh build reproduces it byte for byte.

## License

`wasm/` is derived from valkey-wasm and is under its BSD 3-Clause license (`LICENSE`). Valkey is BSD 3-Clause too. A
build with `ALLOCATOR=mimalloc` also contains mimalloc (MIT), whose license must ship with it.
