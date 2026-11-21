# vendor/

- `valkey.wasm`: Valkey 9.1.1 compiled to WebAssembly (WASI preview1), as produced by `wasm/build.sh` with the default
  `ALLOCATOR=libc` (wasi-libc's dlmalloc): wasi-sdk 34, `-O3`, `-DUSE_MALLOC_USABLE_SIZE`, then `wasm-opt -O3`. See
  [wasm/README.md](../wasm/README.md). This file was built before `wasm/` existed, from the absolute path of a
  [valkey-wasm](https://github.com/michaelkremenetsky/valkey-wasm) checkout, so a fresh build differs only in the
  embedded source file names and the link order.
- `valkey-wasm.patch`: the changes that build carried on top of valkey-wasm v0.1.1. They now live in `wasm/patches/`
  and `wasm/wasi/`.
- `LICENSE`: BSD 3-Clause, covering valkey-wasm and Valkey.
