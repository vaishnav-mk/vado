#!/usr/bin/env bash
# Builds valkey.wasm (WASI reactor) from the pinned Valkey release, patches/ and ../wasi/. Writes build/valkey.wasm.
#   WASI_SDK=/path/to/wasi-sdk-34 [OPT=-O3] packages/wasm/valkey/build.sh
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/../common.sh"

VALKEY_VERSION=9.1.1
VALKEY_SHA256=7d7232acd1b8a49b4e05d07a00b3ca8c801ae06ab633ca6a3423bc5f385ab7ee

fetch "valkey-$VALKEY_VERSION" "https://github.com/valkey-io/valkey/archive/refs/tags/$VALKEY_VERSION.tar.gz" "$VALKEY_SHA256"
VK="$CACHE/valkey-$VALKEY_VERSION" SRC="$CACHE/valkey-$VALKEY_VERSION/src" DEPS="$CACHE/valkey-$VALKEY_VERSION/deps"
# The Makefile writes release.h from git metadata, which a tarball lacks. INFO shows only a hash of it.
cat >"$SRC/release.h" <<'EOF'
#define REDIS_GIT_SHA1 "0"
#define REDIS_GIT_DIRTY "0"
#define REDIS_BUILD_ID "valkey-wasm"
#include "version.h"
#define REDIS_BUILD_ID_RAW SERVER_NAME VALKEY_VERSION REDIS_BUILD_ID REDIS_GIT_DIRTY REDIS_GIT_SHA1
EOF

# LUA_ENABLED/STATIC_LUA: 9.x registers its Lua engine only with these. sentinel.c includes libvalkey's headers;
# the few calls it makes are stubbed in stubs.c.
cflags "$VK" -DLUA_ENABLED -DSTATIC_LUA=1 -I"$SRC" -I"$DEPS/lua/src" -I"$DEPS/hiredis" -I"$DEPS/hdr_histogram" \
  -I"$DEPS/fpconv" -I"$DEPS/fast_float" -I"$WASI" -I"$DEPS/libvalkey/include"
LUA_CFLAGS=(-DLUA_ANSI -DENABLE_CJSON_GLOBAL -DLUA_USE_MKSTEMP "${SJLJ[@]}") # as deps/Makefile

echo "[lua]"
for f in lapi lcode ldebug ldo ldump lfunc lgc llex lmem lobject lopcodes lparser lstate lstring ltable ltm \
  lundump lvm lzio lauxlib lbaselib ldblib liolib lmathlib loslib ltablib lstrlib loadlib linit lua_cjson \
  lua_cmsgpack lua_struct lua_bit fpconv strbuf; do
  compile "$DEPS/lua/src" "$f" "${LUA_CFLAGS[@]}"
done
echo "[deps]"
compile "$DEPS/fpconv" fpconv_dtoa
compile "$DEPS/hdr_histogram" hdr_histogram '-DHDR_MALLOC_INCLUDE="hdr_redis_malloc.h"'

# The server's own objects (ENGINE_SERVER_OBJ + ENGINE_TRACE_OBJ in src/Makefile), minus what needs threads (bio,
# io_threads, threads_mngr: stubs.c runs their API inline) and tls/rdma (unused; they crash this LLVM's codegen).
SERVER_SRC=$({
  sed -n '/^ENGINE_SERVER_OBJ = /,/[^\\]$/p' "$SRC/Makefile"
  sed -n '/^ENGINE_TRACE_OBJ = /,/[^\\]$/p' "$SRC/Makefile"
} | sed 's/^ENGINE_[A-Z_]* = *//; s/\\//g; s/\.o//g' | tr -s ' \t' '\n' | grep -v '^$')
echo "[valkey]"
for f in $SERVER_SRC; do
  case " bio io_threads threads_mngr tls rdma " in *" $f "*) continue ;; esac
  compile "$SRC" "$f"
done

# The Lua engine is a static module loaded through the dlopen shim in stubs.c. Its API pointers are
# __attribute__((__common__)), which this LLVM can't emit for wasm; weak globals merge into one set.
echo "[lua module]"
for f in script_lua engine_lua function_lua debug_lua list; do
  compile "$SRC/modules/lua" "$f" -I"$SRC/modules/lua" -std=gnu11 "-DVALKEYMODULE_ATTR_COMMON=__attribute__((weak))" "${LUA_CFLAGS[@]}"
done

link valkey
