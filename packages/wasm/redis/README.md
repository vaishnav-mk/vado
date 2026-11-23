# packages/wasm/redis

Builds `redis.wasm`, Redis compiled to a WASI reactor module for databases created with the Redis flavour, from the
release tarball pinned in `build.sh`, the patches and `stubs.c` here, and the shared shims in `../wasi/`.

```sh
WASI_SDK=/path/to/wasi-sdk-34.0 packages/wasm/redis/build.sh   # writes packages/wasm/redis/build/redis.wasm
```

How the build works, what each patch changes and how to upgrade: https://vado-docs.vaishnav.one/docs/wasm

`redis.wasm` and the patches and stubs here are distributed under the AGPLv3. `LICENSE.txt` is Redis's own licence.
