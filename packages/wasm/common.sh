# Sourced by valkey/build.sh and redis/build.sh (set HERE first): the toolchain, the download, and the compile
# and link steps both servers share. Each build starts from a fresh upstream tree, so the same wasi-sdk and
# binaryen give the same bytes on any machine.
set -euo pipefail
export LC_ALL=C # the link globs obj/*.o: a fixed collation keeps the object order, and so the bytes

: "${WASI_SDK:?set WASI_SDK to a wasi-sdk 34 install}"
OPT="${OPT:--O3}" # one -O level, for clang and wasm-opt
WASM="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$WASM/.cache" WASI="$WASM/wasi" OUT="$HERE/build" OBJ="$HERE/build/obj"
CC="$WASI_SDK/bin/clang" SYSROOT="$WASI_SDK/share/wasi-sysroot"

# fetch NAME URL SHA256: download once into .cache, check it, extract a fresh tree and apply $HERE/patches.
fetch() {
  local tgz="$CACHE/$1.tar.gz" sum p
  mkdir -p "$CACHE"
  [ -f "$tgz" ] || { curl -fsSL "$2" -o "$tgz.part" && mv "$tgz.part" "$tgz"; }
  sum=$( (sha256sum "$tgz" 2>/dev/null || shasum -a 256 "$tgz") | cut -d' ' -f1)
  [ "$sum" = "$3" ] || { echo "$tgz: sha256 $sum, want $3" >&2; exit 1; }
  rm -rf "${CACHE:?}/$1" "$OUT"
  mkdir -p "$CACHE/$1" "$OBJ"
  tar -xzf "$tgz" -C "$CACHE/$1" --strip-components=1
  for p in "$HERE"/patches/*.patch; do echo "patch $(basename "$p")"; patch -s -p1 -F0 -d "$CACHE/$1" -i "$p"; done
}

# cflags TREE FLAGS...: what every object is compiled with, around the server's own defines and includes.
cflags() {
  local tree=$1
  shift
  CFLAGS=(
    --target=wasm32-wasip1 --sysroot="$SYSROOT" $OPT -fno-strict-aliasing
    -Wno-implicit-function-declaration -Wno-int-conversion -Wno-macro-redefined -Wno-unused -Wno-incompatible-pointer-types
    -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID
    -DVALKEY_WASM=1 -DHAVE_WASI_AE=1 # the shims' "built for the wasm host", for Redis too
    -DUSE_MALLOC_USABLE_SIZE # wasi-libc's dlmalloc has it: zmalloc keeps no size prefix per allocation
    "$@"
    -ffile-prefix-map="$tree/"= # assertion file names relative to the tree, not this machine
    -include "$WASI/wasm_compat.h"
  )
}

LDFLAGS=(
  --target=wasm32-wasip1 --sysroot="$SYSROOT" -mexec-model=reactor
  -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman -lwasi-emulated-getpid
  -lc-printscan-long-double # the default printf/strtold trap on long double, which INCRBYFLOAT and scores parse
  -Wl,--allow-undefined # host imports resolve at instantiation
  -Wl,--export-dynamic
  -Wl,-z,stack-size=1048576
  -Wl,--wrap=read,--wrap=write,--wrap=writev,--wrap=close,--wrap=fcntl # sock_shim.c: host fds go to the host
)

# Lua errors are setjmp/longjmp, lowered to wasm exceptions (the host supplies env.__c_longjmp).
SJLJ=(-mllvm -wasm-enable-sjlj)

compile() { # DIR NAME [FLAGS...]
  local dir=$1 f=$2
  shift 2
  echo "  $f"
  "$CC" "${CFLAGS[@]}" "$@" -c "$dir/$f.c" -o "$OBJ/$(echo "$f" | tr / _).o"
}

# link NAME: the shared shims and this server's stubs.c, then everything into $OUT/NAME.wasm. LUA_CFLAGS: the
# server's Lua flags (setjmp/longjmp needs the same codegen as Lua).
link() {
  echo "[wasi]"
  compile "$WASI" sock_shim
  compile "$WASI" reactor
  compile "$HERE" stubs
  compile "$WASI" wasm_sjlj "${LUA_CFLAGS[@]}"
  echo "[link]"
  "$CC" "${LDFLAGS[@]}" "$OBJ"/*.o -o "$OUT/$1.wasm"
  wasm-opt -g --strip-dwarf $OPT "$OUT/$1.wasm" -o "$OUT/$1.wasm" # keeps the name section
  ls -l "$OUT/$1.wasm"
}
