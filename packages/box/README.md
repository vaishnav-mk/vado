# Native Redis in containers (experimental)

The `redis-native` flavour runs unmodified Redis 8.12.0, built from the same pinned release as `packages/wasm/redis`,
in a Cloudflare Container next to each shard's Durable Object. The router, catalog, AUTH and dashboard are the same as
for the wasm flavours. Build with `VADO_CONTAINERS=1`, then create a database with `flavour=redis-native`.

The design, limits and measurements are on the docs site's "Native Redis" page. This file maps the code.

## Image

`redis/Dockerfile`: Redis from the release tarball (checked by sha256), with the system jemalloc and no TLS, on
debian:trixie-slim. It adds netcat, which a restore uses to stream the stored RDB in.

## Code (`packages/server/src/box/`)

| File | What it does |
|---|---|
| `box.ts` | `RedisBox`, the shard's Durable Object: boots the engine, takes client sockets and RPC batches |
| `engine.ts` | A running container and its replication link; compaction and the idle stop |
| `redis.ts` | Starting and restoring a container: the gate file, the copy over netcat, the replay |
| `link.ts` | The replica link: a full sync into storage, then the stream, with offsets callers wait on |
| `proxy.ts` | A client connection to Redis, with each batch's replies held until its writes are stored |
| `mux.ts` | One pipelined Redis connection shared by RPC batches |
| `store.ts` | Generations of stored RDB and stream in SQLite |

## Rules

- A reply leaves only once the replication stream up to the batch's `ROLE` offset is stored.
- A generation becomes current only once it holds everything the one before it does.
- A running container that never finished its restore is destroyed, never synced from.
- Redis keeps no data of its own (`save ""`, `appendonly no`): the object's storage is the only copy.

## Test

```sh
docker build --platform linux/amd64 -t vado-redis packages/box/redis
BOX_IMAGE=vado-redis npx vitest run packages/server/test/box
```

That runs Redis in Docker through a full sync, the stream, a compaction to a second generation, then a restore from
storage alone, compared by `DEBUG DIGEST`. Without `BOX_IMAGE` it is skipped.
