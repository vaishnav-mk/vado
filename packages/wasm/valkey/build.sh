#!/usr/bin/env bash
# See https://vado-docs.vaishnav.one/docs/wasm
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/../common.sh"

VALKEY_VERSION=9.1.1
VALKEY_SHA256=7d7232acd1b8a49b4e05d07a00b3ca8c801ae06ab633ca6a3423bc5f385ab7ee

fetch "valkey-$VALKEY_VERSION" "https://github.com/valkey-io/valkey/archive/refs/tags/$VALKEY_VERSION.tar.gz" "$VALKEY_SHA256"
VK="$CACHE/valkey-$VALKEY_VERSION" SRC="$CACHE/valkey-$VALKEY_VERSION/src" DEPS="$CACHE/valkey-$VALKEY_VERSION/deps"
# The Makefile writes release.h from git metadata, which a tarball lacks.
cat >"$SRC/release.h" <<'EOF'
#define REDIS_GIT_SHA1 "0"
#define REDIS_GIT_DIRTY "0"
#define REDIS_BUILD_ID "valkey-wasm"
#include "version.h"
#define REDIS_BUILD_ID_RAW SERVER_NAME VALKEY_VERSION REDIS_BUILD_ID REDIS_GIT_DIRTY REDIS_GIT_SHA1
EOF

# 9.x registers its Lua engine only with LUA_ENABLED/STATIC_LUA. sentinel.c includes libvalkey's headers.
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

# Minus what needs threads (stubs.c runs it inline) and tls/rdma (unused; they crash this LLVM's codegen).
SERVER_SRC=$({
  sed -n '/^ENGINE_SERVER_OBJ = /,/[^\\]$/p' "$SRC/Makefile"
  sed -n '/^ENGINE_TRACE_OBJ = /,/[^\\]$/p' "$SRC/Makefile"
} | sed 's/^ENGINE_[A-Z_]* = *//; s/\\//g; s/\.o//g' | tr -s ' \t' '\n' | grep -v '^$')
echo "[valkey]"
for f in $SERVER_SRC; do
  case " bio io_threads threads_mngr tls rdma " in *" $f "*) continue ;; esac
  compile "$SRC" "$f"
done

# This LLVM can't emit __attribute__((__common__)) for wasm; weak globals merge the same way.
echo "[lua module]"
for f in script_lua engine_lua function_lua debug_lua list; do
  compile "$SRC/modules/lua" "$f" -I"$SRC/modules/lua" -std=gnu11 "-DVALKEYMODULE_ATTR_COMMON=__attribute__((weak))" "${LUA_CFLAGS[@]}"
done

link valkey
