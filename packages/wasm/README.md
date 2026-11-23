# @vado/wasm

Valkey and Redis compiled to WebAssembly (WASI preview1 reactors) from pinned upstream releases, with the patches,
shims and build scripts that make them. `valkey/valkey.wasm` and `redis/redis.wasm` are the committed builds.

```sh
WASI_SDK=/path/to/wasi-sdk-34.0 packages/wasm/valkey/build.sh   # writes packages/wasm/valkey/build/valkey.wasm
WASI_SDK=/path/to/wasi-sdk-34.0 packages/wasm/redis/build.sh    # writes packages/wasm/redis/build/redis.wasm
```

How the builds work, what each patch does, the host interface, and how to upgrade or change a build:
[WebAssembly builds](https://vado-docs.vaishnav.one/docs/wasm).

The Valkey build is BSD 3-Clause (`LICENSE`); the Redis build is AGPL-3.0 ([`redis/README.md`](redis/README.md)).
