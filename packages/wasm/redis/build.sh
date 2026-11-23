#!/usr/bin/env bash
# See https://vado-docs.vaishnav.one/docs/wasm
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/../common.sh"

REDIS_VERSION=8.12.0
REDIS_SHA256=07e2477372566acf587e32c1abc8af088ad901fb2c725388ec9a5bef29c47319

fetch "redis-$REDIS_VERSION" "https://github.com/redis/redis/archive/refs/tags/$REDIS_VERSION.tar.gz" "$REDIS_SHA256"
RD="$CACHE/redis-$REDIS_VERSION" SRC="$CACHE/redis-$REDIS_VERSION/src" DEPS="$CACHE/redis-$REDIS_VERSION/deps"
cat >"$SRC/release.h" <<'EOF'
#define REDIS_GIT_SHA1 "00000000"
#define REDIS_GIT_DIRTY "0"
#define REDIS_BUILD_ID "redis-wasm"
#include "version.h"
#define REDIS_BUILD_ID_RAW REDIS_VERSION REDIS_BUILD_ID REDIS_GIT_DIRTY REDIS_GIT_SHA1
EOF

# include/module.h stands in for Valkey's, which the shared reactor.c includes.
cflags "$RD" -I"$SRC" -I"$DEPS/lua/src" -I"$DEPS/hiredis" -I"$DEPS/hdr_histogram" -I"$DEPS/fpconv" \
  -I"$DEPS/xxhash" -I"$DEPS/croaring/include" -I"$HERE/include" -I"$WASI"
LUA_CFLAGS=(-DLUA_ANSI -DENABLE_CJSON_GLOBAL "-DREDIS_STATIC=" -DLUA_USE_MKSTEMP "${SJLJ[@]}") # as deps/Makefile

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

# Minus bio (it starts threads; stubs.c runs its jobs inline) and tls (unused).
echo "[redis]"
for f in $(sed -n 's/^REDIS_SERVER_OBJ=//p' "$SRC/Makefile" | tr ' ' '\n' | sed 's/\.o$//' | grep -v '^$'); do
  case " bio tls " in *" $f "*) continue ;; esac
  compile "$SRC" "$f"
done

link redis
