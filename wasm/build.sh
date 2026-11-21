#!/usr/bin/env bash
# Build Valkey as a wasm32-wasip1 reactor: pristine upstream source, patches/,
# and the WASI shims in wasi/. Writes build/valkey.wasm. No fork, no threads;
# networking and the event loop are bridged to the host (see wasi/host.h).
#
#   WASI_SDK=/path/to/wasi-sdk-34 [ALLOCATOR=libc|mimalloc] [OPT=-O3] wasm/build.sh
set -euo pipefail
# The link globs build/obj/*.o; a fixed collation keeps the object order, and so
# the output bytes, the same on every machine.
export LC_ALL=C

VALKEY_VERSION=9.1.1
VALKEY_SHA256=7d7232acd1b8a49b4e05d07a00b3ca8c801ae06ab633ca6a3423bc5f385ab7ee
MIMALLOC_VERSION=3.7.0
MIMALLOC_SHA256=1b8653b9ff9b841a97f2c50fd996e89e1a0cb712c3c5b0980ef16a027eb7acf8

: "${WASI_SDK:?set WASI_SDK to a wasi-sdk 34 install}"
ALLOCATOR="${ALLOCATOR:-libc}"
OPT="${OPT:--O3}" # one -O level, for clang and wasm-opt
case "$ALLOCATOR" in libc | mimalloc) ;; *) echo "ALLOCATOR must be libc or mimalloc" >&2; exit 1 ;; esac

HERE="$(cd "$(dirname "$0")" && pwd)"
CACHE="$HERE/.cache"
OUT="$HERE/build"
OBJ="$OUT/obj"
WASI="$HERE/wasi"
CC="$WASI_SDK/bin/clang"
SYSROOT="$WASI_SDK/share/wasi-sysroot"

# fetch NAME URL SHA256: download once into .cache, check it, extract a fresh tree.
fetch() {
  local tgz="$CACHE/$1.tar.gz" sum
  [ -f "$tgz" ] || { curl -fsSL "$2" -o "$tgz.part" && mv "$tgz.part" "$tgz"; }
  sum=$( (sha256sum "$tgz" 2>/dev/null || shasum -a 256 "$tgz") | cut -d' ' -f1)
  [ "$sum" = "$3" ] || { echo "$tgz: sha256 $sum, want $3" >&2; exit 1; }
  rm -rf "${CACHE:?}/$1"
  mkdir -p "$CACHE/$1"
  tar -xzf "$tgz" -C "$CACHE/$1" --strip-components=1
}

mkdir -p "$CACHE"
fetch "valkey-$VALKEY_VERSION" "https://github.com/valkey-io/valkey/archive/refs/tags/$VALKEY_VERSION.tar.gz" "$VALKEY_SHA256"
VK="$CACHE/valkey-$VALKEY_VERSION"
SRC="$VK/src"
DEPS="$VK/deps"
PATCHES=("$HERE"/patches/*.patch)
[ "$ALLOCATOR" = libc ] || PATCHES+=("$HERE/patches/$ALLOCATOR"/*.patch)
for p in "${PATCHES[@]}"; do
  echo "patch $(basename "$p")"
  patch -s -p1 -F0 -d "$VK" -i "$p"
done
# Upstream's Makefile writes release.h from git metadata, which a tarball lacks.
# Pinned to the values the earlier vendor/valkey.wasm was built with; INFO shows
# only a hash of them (redis_build_id).
cat >"$SRC/release.h" <<'EOF'
#define REDIS_GIT_SHA1 "0"
#define REDIS_GIT_DIRTY "0"
#define REDIS_BUILD_ID "valkey-wasm"
#include "version.h"
#define REDIS_BUILD_ID_RAW SERVER_NAME VALKEY_VERSION REDIS_BUILD_ID REDIS_GIT_DIRTY REDIS_GIT_SHA1
EOF

rm -rf "$OUT"
mkdir -p "$OBJ"

if [ "$ALLOCATOR" = mimalloc ]; then
  fetch "mimalloc-$MIMALLOC_VERSION" "https://github.com/microsoft/mimalloc/archive/refs/tags/v$MIMALLOC_VERSION.tar.gz" "$MIMALLOC_SHA256"
  MI="$CACHE/mimalloc-$MIMALLOC_VERSION"
  # zmalloc calls mi_* directly (patches/mimalloc); INFO shows mimalloc-x.y.z.
  ALLOC_CFLAGS=(-DUSE_MIMALLOC "-DMIMALLOC_VERSION=\"$MIMALLOC_VERSION\"" -I"$MI/include")
  # mimalloc's overrides have explicit default visibility, so --export-dynamic
  # would export ~50 of them. Export only what it adds to the libc build.
  ALLOC_LDFLAGS=(-Wl,--export=__stack_pointer)
  # The whole library as one object. MI_MALLOC_OVERRIDE defines malloc/free/
  # calloc/realloc/posix_memalign/aligned_alloc/malloc_usable_size and the
  # __libc_* entry points, so wasi-libc's dlmalloc is never pulled from libc.a
  # and Lua (lauxlib's l_alloc) and libc internals share mimalloc's heap.
  # MI_DEFAULT_ARENA_RESERVE is in KiB. mimalloc quarters it where memory can't
  # be reserved without committing (wasm), and on wasm32 an arena can't be
  # smaller than 16 MiB, so 64 MiB gives the smallest step: linear memory grows
  # 16 MiB at a time instead of 32 MiB.
  echo "[mimalloc $MIMALLOC_VERSION]"
  "$CC" --target=wasm32-wasip1 --sysroot="$SYSROOT" $OPT \
    -DNDEBUG -DMI_DEBUG=0 -DMI_SECURE=0 -DMI_STATS=0 -DMI_PADDING=0 -DMI_GUARDED=0 -DMI_PROFILE=0 \
    -DMI_MALLOC_OVERRIDE -DMI_DEFAULT_ARENA_RESERVE=65536 \
    -D_WASI_EMULATED_PROCESS_CLOCKS -I"$MI/include" \
    -c "$MI/src/static.c" -o "$OBJ/mimalloc.o"
else
  # wasi-libc's dlmalloc has malloc_usable_size: zmalloc drops its 8-byte size
  # prefix per allocation and asks the allocator instead.
  ALLOC_CFLAGS=(-DUSE_MALLOC_USABLE_SIZE)
  ALLOC_LDFLAGS=(-Wl,--export-dynamic)
fi

CFLAGS=(
  --target=wasm32-wasip1 --sysroot="$SYSROOT"
  $OPT -fno-strict-aliasing -Wno-implicit-function-declaration
  -Wno-int-conversion -Wno-macro-redefined -Wno-unused
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID
  -DVALKEY_WASM=1 -DHAVE_WASI_AE=1
  "${ALLOC_CFLAGS[@]}"
  # 9.x builds Lua as a static module; server.c registers the "lua" scripting
  # engine only with these set (else EVAL: "Could not find scripting engine").
  -DLUA_ENABLED -DSTATIC_LUA=1
  -I"$SRC" -I"$DEPS/lua/src" -I"$DEPS/hiredis" -I"$DEPS/hdr_histogram"
  -I"$DEPS/fpconv" -I"$DEPS/fast_float" -I"$WASI"
  # sentinel.c includes the bundled client's <valkey/...> headers. libvalkey
  # isn't built; the few calls sentinel makes are stubbed in wasi/stubs.c.
  -I"$DEPS/libvalkey/include"
  # Assertion file names (__FILE__) relative to the Valkey tree, not this machine.
  -ffile-prefix-map="$VK/"=
  -include "$WASI/wasm_compat.h"
)
LDFLAGS=(
  --target=wasm32-wasip1 --sysroot="$SYSROOT"
  -mexec-model=reactor
  -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman -lwasi-emulated-getpid
  # wasi-libc's default printf/scanf/strtold trap on long double. Valkey parses
  # long doubles (INCRBYFLOAT, ZADD scores, blocking timeouts via strtold).
  -lc-printscan-long-double
  -Wl,--allow-undefined # host imports resolve at instantiation
  "${ALLOC_LDFLAGS[@]}"
  -Wl,-z,stack-size=1048576
  # sock_shim.c provides __wrap_* for the fd-multiplexed libc calls: host fds
  # (>= HOST_FD_BASE) go to the host, the rest to wasi-libc.
  -Wl,--wrap=read,--wrap=write,--wrap=writev,--wrap=close,--wrap=fcntl
)

compile() { # DIR NAME [FLAGS...]
  local dir=$1 f=$2
  shift 2
  echo "  $f"
  "$CC" "${CFLAGS[@]}" "$@" -c "$dir/$f.c" -o "$OBJ/$(basename "$f").o"
}

# Lua errors are setjmp/longjmp, lowered to wasm exceptions (the host supplies
# the env.__c_longjmp tag). ENABLE_CJSON_GLOBAL, LUA_ANSI and LUA_USE_MKSTEMP
# match deps/Makefile.
LUA_CFLAGS=(-DLUA_ANSI -DENABLE_CJSON_GLOBAL -DLUA_USE_MKSTEMP -mllvm -wasm-enable-sjlj)
echo "[lua]"
for f in lapi lcode ldebug ldo ldump lfunc lgc llex lmem lobject lopcodes lparser lstate lstring ltable ltm \
  lundump lvm lzio lauxlib lbaselib ldblib liolib lmathlib loslib ltablib lstrlib loadlib linit lua_cjson \
  lua_cmsgpack lua_struct lua_bit fpconv strbuf; do
  compile "$DEPS/lua/src" "$f" "${LUA_CFLAGS[@]}"
done
echo "[deps]"
compile "$DEPS/fpconv" fpconv_dtoa
# Latency and commandlog histograms, on Valkey's allocator like upstream.
compile "$DEPS/hdr_histogram" hdr_histogram '-DHDR_MALLOC_INCLUDE="hdr_redis_malloc.h"'

# The server target's own object list (ENGINE_SERVER_OBJ + ENGINE_TRACE_OBJ in
# src/Makefile), so CLI/benchmark objects stay out. Each list runs from
# "NAME = \" to the first line without a trailing backslash.
SERVER_SRC=$({
  sed -n '/^ENGINE_SERVER_OBJ = /,/[^\\]$/p' "$SRC/Makefile"
  sed -n '/^ENGINE_TRACE_OBJ = /,/[^\\]$/p' "$SRC/Makefile"
} | sed 's/^ENGINE_[A-Z_]* = *//; s/\\//g; s/\.o//g' | tr -s ' \t' '\n' | grep -v '^$')
# bio, io_threads, threads_mngr need pthreads (wasip1 has none); stubs.c runs
# their API inline. tls and rdma crash this LLVM's codegen even in their
# disabled forms, and neither is used; stubs.c has the symbols connection.c needs.
EXCLUDE_TU=" bio io_threads threads_mngr tls rdma "
echo "[valkey]"
for f in $SERVER_SRC; do
  case "$EXCLUDE_TU" in *" $f "*) continue ;; esac
  compile "$SRC" "$f"
done
# ae_wasi.c is #included by ae.c (patches/0001), never compiled alone.

# The Lua engine is a static module (src/modules/lua) loaded at startup through
# the dlopen/dlsym shim in stubs.c. valkeymodule.h marks the API pointers
# __attribute__((__common__)), which this LLVM can't emit for wasm and which
# would collide once linked into one image; weak globals merge into one set.
echo "[lua module]"
for f in script_lua engine_lua function_lua debug_lua list; do
  compile "$SRC/modules/lua" "$f" -I"$SRC/modules/lua" -std=gnu11 \
    "-DVALKEYMODULE_ATTR_COMMON=__attribute__((weak))" "${LUA_CFLAGS[@]}"
done

echo "[wasi]"
for f in sock_shim stubs reactor; do
  compile "$WASI" "$f"
done
# setjmp/longjmp runtime: needs the same wasm-exception codegen as Lua.
compile "$WASI" wasm_sjlj "${LUA_CFLAGS[@]}"

echo "[link]"
"$CC" "${LDFLAGS[@]}" "$OBJ"/*.o -o "$OUT/valkey.wasm"
# binaryen on top of LLVM. -g keeps the name section; DWARF goes first.
wasm-opt -g --strip-dwarf $OPT "$OUT/valkey.wasm" -o "$OUT/valkey.wasm"
ls -l "$OUT/valkey.wasm"
