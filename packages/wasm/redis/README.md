# wasm/redis/

Builds `redis.wasm`, Redis 8.12.0 compiled to WebAssembly, for databases created with the Redis flavour. It is built
the way `../build.sh` builds Valkey: pristine upstream source, a few patches, and the WASI shims in `../wasi/`. It has
the same exports as `valkey.wasm` and nearly the same imports (below), so `src/shard/valkey-host.js` runs either.

```sh
WASI_SDK=/path/to/wasi-sdk-34.0 wasm/redis/build.sh                # writes wasm/redis/build/redis.wasm
cp wasm/redis/build/redis.wasm wasm/redis/redis.wasm
node wasm/interface.mjs wasm/redis/redis.wasm > wasm/redis/interface.txt
```

Needs what `../build.sh` needs. The script downloads the Redis tarball into `wasm/.cache/`, checks its sha256,
extracts a fresh tree, applies the patches, and compiles Lua, the small deps and the server objects listed in
Redis's own Makefile, except `bio` (it starts threads) and `tls`. CI rebuilds it and checks that the bytes and
`interface.txt` match (`.github/workflows/wasm.yml`).

## Layout

- `patches/`, applied in order:
  - `0001-ae-wasi-backend.patch`, `0002-reactor-main.patch`: as for Valkey. `ae.c` polls through the host, and
    `main()` returns after init so the host runs the event loop (`../wasi/reactor.c`).
  - `0003-aof-rewrite-without-fork.patch`: Valkey's `0003` and `0004` in one. There is no `fork()`, so Redis offers
    the rewrite to the host (the `aof_rewrite` import) and otherwise rewrites inline; `rk_rewrite_done(ok, gen)`
    finishes it the way the parent does when a child exits.
  - `0004-no-context-switch-counts.patch`: the slowlog's CPU sample reads `ru_nvcsw`, which WASI's `rusage` lacks.
  - `0005-import-mode.patch`: Valkey's `import-mode`, which Redis lacks. Read replicas and rewriters run with it.
    With it on, nothing expires on its own: active expiry is off, a write (the only writer is the primary's stream)
    sees expired keys and hash fields as alive, as the primary did, and anything else sees them as gone without
    deleting them. A key the stream sets with an expiry already past stays until the stream deletes it. Without it,
    a replica whose stream runs a few ms behind would drop a key that the primary then kept alive.
  - `0006-utc-log-times.patch`: as Valkey's `0005`, log lines in UTC.
- `stubs.c`: what Redis needs that wasm32-wasip1 lacks. bio jobs run inline, and completion callbacks run on the
  next event loop pass. fork, exec, `dlopen`, TLS and the hiredis async calls fail or do nothing.
- `include/module.h`: the shared `reactor.c` includes Valkey's `module.h`; this one includes `server.h`.

## Differences from valkey.wasm

- Imports: Redis also imports `path_link` and `path_readlink` and doesn't import `sched_yield`. The host answers any
  WASI call it doesn't implement with `ENOSYS`. Redis calls `link()` when it installs a preloaded AOF, and falls
  back to copying.
- Redis has no `CLIENT IMPORT-SOURCE`. A replica's stream sends it anyway, with replies off; patch `0005` treats
  every write as the stream's instead.
- `INFO` shows `executable:/valkey-server`, the name the shared `reactor.c` passes as `argv[0]`.

## License

Redis 8 is available under your choice of RSALv2, SSPLv1 or AGPLv3 (`LICENSE.txt`, Redis's own file, has all three).
`redis.wasm` and the patches and stubs here are distributed under the GNU Affero General Public License v3. The AGPL's
network clause means that anyone running the Redis flavour for other people must offer them this source: the
tarball pinned in `build.sh`, and this directory and `../wasi/`. Redis 7.2 and earlier were BSD-3-Clause; Valkey,
and `valkey.wasm`, still are.
