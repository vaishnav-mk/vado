#!/usr/bin/env bash
# Build Redis as a wasm32-wasip1 reactor, the same way wasm/build.sh builds Valkey: pristine upstream source,
# redis/patches/, the shared WASI shims in wasm/wasi/ and the Redis stubs here. Writes build/redis.wasm, with
# the same exports and host imports as valkey.wasm, so src/shard/valkey-host.js runs either.
#
#   WASI_SDK=/path/to/wasi-sdk-34 [OPT=-O3] wasm/redis/build.sh
set -euo pipefail
export LC_ALL=C # the link globs build/obj/*.o: a fixed collation keeps the output bytes the same everywhere

REDIS_VERSION=8.12.0
REDIS_SHA256=07e2477372566acf587e32c1abc8af088ad901fb2c725388ec9a5bef29c47319

: "${WASI_SDK:?set WASI_SDK to a wasi-sdk 34 install}"
OPT="${OPT:--O3}"

HERE="$(cd "$(dirname "$0")" && pwd)"
WASM="$(dirname "$HERE")"
CACHE="$WASM/.cache"
OUT="$HERE/build"
OBJ="$OUT/obj"
WASI="$WASM/wasi"
CC="$WASI_SDK/bin/clang"
SYSROOT="$WASI_SDK/share/wasi-sysroot"

fetch() { # NAME URL SHA256: download once into .cache, check it, extract a fresh tree
  local tgz="$CACHE/$1.tar.gz" sum
  [ -f "$tgz" ] || { curl -fsSL "$2" -o "$tgz.part" && mv "$tgz.part" "$tgz"; }
  sum=$( (sha256sum "$tgz" 2>/dev/null || shasum -a 256 "$tgz") | cut -d' ' -f1)
  [ "$sum" = "$3" ] || { echo "$tgz: sha256 $sum, want $3" >&2; exit 1; }
  rm -rf "${CACHE:?}/$1"
  mkdir -p "$CACHE/$1"
  tar -xzf "$tgz" -C "$CACHE/$1" --strip-components=1
}

mkdir -p "$CACHE"
fetch "redis-$REDIS_VERSION" "https://github.com/redis/redis/archive/refs/tags/$REDIS_VERSION.tar.gz" "$REDIS_SHA256"
RD="$CACHE/redis-$REDIS_VERSION"
SRC="$RD/src"
DEPS="$RD/deps"
for p in "$HERE"/patches/*.patch; do
  echo "patch $(basename "$p")"
  patch -s -p1 -F0 -d "$RD" -i "$p"
done
# Upstream's Makefile writes release.h from git metadata, which a tarball lacks.
cat >"$SRC/release.h" <<'EOF'
#define REDIS_GIT_SHA1 "00000000"
#define REDIS_GIT_DIRTY "0"
#define REDIS_BUILD_ID "redis-wasm"
#include "version.h"
#define REDIS_BUILD_ID_RAW REDIS_VERSION REDIS_BUILD_ID REDIS_GIT_DIRTY REDIS_GIT_SHA1
EOF

rm -rf "$OUT"
mkdir -p "$OBJ"

CFLAGS=(
  --target=wasm32-wasip1 --sysroot="$SYSROOT"
  $OPT -fno-strict-aliasing -Wno-implicit-function-declaration
  -Wno-int-conversion -Wno-macro-redefined -Wno-unused -Wno-incompatible-pointer-types
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID
  # VALKEY_WASM and HAVE_WASI_AE are the shared shim's names for "built for the wasm host" (wasm/wasi/).
  -DVALKEY_WASM=1 -DHAVE_WASI_AE=1
  # wasi-libc's dlmalloc has malloc_usable_size: zmalloc asks it instead of keeping a size prefix.
  -DUSE_MALLOC_USABLE_SIZE
  -I"$SRC" -I"$DEPS/lua/src" -I"$DEPS/hiredis" -I"$DEPS/hdr_histogram" -I"$DEPS/fpconv"
  -I"$DEPS/xxhash" -I"$DEPS/croaring/include"
  -I"$HERE/include" -I"$WASI"
  -ffile-prefix-map="$RD/"=
  -include "$WASI/wasm_compat.h"
)
LDFLAGS=(
  --target=wasm32-wasip1 --sysroot="$SYSROOT"
  -mexec-model=reactor
  -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman -lwasi-emulated-getpid
  -lc-printscan-long-double
  -Wl,--allow-undefined # host imports resolve at instantiation
  -Wl,--export-dynamic
  -Wl,-z,stack-size=1048576
  -Wl,--wrap=read,--wrap=write,--wrap=writev,--wrap=close,--wrap=fcntl
)

compile() { # DIR NAME [FLAGS...]
  local dir=$1 f=$2
  shift 2
  echo "  $f"
  "$CC" "${CFLAGS[@]}" "$@" -c "$dir/$f.c" -o "$OBJ/$(echo "$f" | tr / _).o"
}

# Lua errors are setjmp/longjmp, lowered to wasm exceptions (the host supplies env.__c_longjmp).
# The defines match deps/Makefile.
LUA_CFLAGS=(-DLUA_ANSI -DENABLE_CJSON_GLOBAL "-DREDIS_STATIC=" -DLUA_USE_MKSTEMP -mllvm -wasm-enable-sjlj)
echo "[lua]"
for f in lapi lcode ldebug ldo ldump lfunc lgc llex lmem lobject lopcodes lparser lstate lstring ltable ltm \
  lundump lvm lzio strbuf fpconv lauxlib lbaselib ldblib liolib lmathlib loslib ltablib lstrlib loadlib linit \
  lua_cjson lua_struct lua_cmsgpack lua_bit; do
  compile "$DEPS/lua/src" "$f" "${LUA_CFLAGS[@]}"
done
echo "[deps]"
compile "$DEPS/fpconv" fpconv_dtoa
compile "$DEPS/hdr_histogram" hdr_histogram '-DHDR_MALLOC_INCLUDE="hdr_redis_malloc.h"'
compile "$DEPS/xxhash" xxhash
for f in regcomp regerror regexec tre-ast tre-compile tre-filter tre-match-backtrack tre-match-parallel tre-mem tre-parse tre-stack; do
  [ -f "$DEPS/tre/lib/$f.c" ] && compile "$DEPS/tre/lib" "$f" -DTRE_REGEX_T_FIELD=value -I"$DEPS/tre/local_includes" -I"$DEPS/tre/lib"
done
for f in isadetection array_util bitset_util art/art bitset containers/array containers/bitset containers/containers \
  containers/convert containers/mixed_intersection containers/mixed_union containers/mixed_equal containers/mixed_subset \
  containers/mixed_negation containers/mixed_xor containers/mixed_andnot containers/run memory roaring roaring64 \
  roaring_priority_queue roaring_array; do
  compile "$DEPS/croaring/src" "$f" -std=gnu11 -DROARING_DISABLE_X64=1 -DDISABLENEON=1 -I"$DEPS/croaring/src"
done

# The server target's object list from src/Makefile, minus bio (it starts threads at boot; stubs.c runs its
# jobs inline) and tls (unused). iothread and threads_mngr build, and start nothing with io-threads 1.
SERVER_SRC=$(sed -n 's/^REDIS_SERVER_OBJ=//p' "$SRC/Makefile" | tr ' ' '\n' | sed 's/\.o$//' | grep -v '^$')
EXCLUDE_TU=" bio tls "
echo "[redis]"
for f in $SERVER_SRC; do
  case "$EXCLUDE_TU" in *" $f "*) continue ;; esac
  compile "$SRC" "$f"
done

echo "[wasi]"
compile "$WASI" sock_shim
compile "$WASI" reactor
compile "$HERE" stubs
compile "$WASI" wasm_sjlj "${LUA_CFLAGS[@]}"

echo "[link]"
"$CC" "${LDFLAGS[@]}" "$OBJ"/*.o -o "$OUT/redis.wasm"
wasm-opt -g --strip-dwarf $OPT "$OUT/redis.wasm" -o "$OUT/redis.wasm"
ls -l "$OUT/redis.wasm"
