# vendor/

- `valkey.wasm`: Valkey 9.1.1 compiled to WebAssembly (WASI preview1), as produced by `wasm/build.sh` with the default
  `ALLOCATOR=libc` (wasi-libc's dlmalloc): wasi-sdk 34, `-O3`, `-DUSE_MALLOC_USABLE_SIZE`, then `wasm-opt -O3`. See
  [wasm/README.md](../wasm/README.md). A fresh `wasm/build.sh` reproduces it byte for byte.
- `LICENSE`: BSD 3-Clause, covering valkey-wasm and Valkey.
