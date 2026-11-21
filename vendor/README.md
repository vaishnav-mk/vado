# vendor/

- `valkey.wasm`: Valkey 9.1.1 compiled to WebAssembly (WASI preview1), from
  [valkey-wasm](https://github.com/michaelkremenetsky/valkey-wasm) v0.1.1 with `valkey-wasm.patch` applied, built with
  wasi-sdk 34 (`WASI_SDK=... bash scripts/build.sh` in that repo): `-O3`, `-DUSE_MALLOC_USABLE_SIZE`, then
  `wasm-opt -O3` (binaryen, on PATH).
- `valkey-wasm.patch`: lets the host pass argv (`rk_boot_args`), makes the AOF rewrite run inline since there is no
  `fork()` in wasm, adds `rk_tick` (one event-loop pass that ends with beforeSleep, so one call per wake), and makes the
  poll backend track interest incrementally instead of scanning every fd slot.
- `LICENSE`: BSD 3-Clause, covering valkey-wasm and Valkey.
