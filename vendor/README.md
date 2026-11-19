# vendor/

- `valkey.wasm`: Valkey 9.1.1 compiled to WebAssembly (WASI preview1), from
  [valkey-wasm](https://github.com/michaelkremenetsky/valkey-wasm) v0.1.1 with `valkey-wasm.patch` applied, built with
  wasi-sdk 34 (`WASI_SDK=... bash scripts/build.sh` in that repo).
- `valkey-wasm.patch`: lets the host pass argv (`rk_boot_args`) and makes the AOF rewrite run inline, since there is no
  `fork()` in wasm.
- `LICENSE`: BSD 3-Clause, covering valkey-wasm and Valkey.
