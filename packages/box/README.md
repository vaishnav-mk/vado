# Valkey and Redis in containers (experimental)

The `valkey-native` and `redis-native` flavours run unmodified Valkey 9.1.1 or Redis 8.12.0, built from the same pinned
release tarballs as `packages/wasm`, in a Cloudflare Container next to each shard's Durable Object. The router,
catalog, AUTH and dashboard are the same as for the wasm flavours. Build with `VADO_CONTAINERS=1` (plus `VADO_REDIS=1`
for Redis), then create a database with `flavour=valkey-native` or `flavour=redis-native`.

The design, limits and measurements are on the docs site's "Flavours" page. This file maps the code.

## Image

`Dockerfile`: one server, picked with `--build-arg SERVER=valkey|redis`, built from its release tarball (checked by
sha256; `packages/wasm/update.sh` moves the pins with the wasm builds) on debian:trixie-slim. It adds netcat, which a
restore uses to take the stored RDB.

## Code (`packages/server/src/box/`)

| File | What it does |
|---|---|
| `box.ts` | `RedisBox`, the shard's Durable Object for either server: boots the engine, takes client sockets and RPC batches |
| `engine.ts` | A running container and its replication link: compaction, pruning, and the idle stop |
| `attach.ts` | Where a stored stream can go on, and opening the replica link |
| `container.ts` | Starting and restoring a container: reuse or replace, the copy over netcat, retries |
| `server.ts` | Reaching the server in the container: readiness, the replay in batches, its replication history |
| `link.ts` | The replica link: continue the stored stream or take a full sync, then store the stream |
| `rdb.ts` | Storing a full sync's RDB, a window at a time, each committed before the next is read |
| `proxy.ts` | A client connection to the server, with each batch's replies held until its writes are stored |
| `mux.ts` | One pipelined server connection shared by RPC batches |
| `store.ts` | Generations of stored RDB and stream in SQLite |

## Rules

- A reply leaves only once the replication stream up to the batch's `ROLE` offset is stored.
- A generation becomes current only once it holds everything the one before it does.
- Every sync gets a generation number no earlier one used, so a retry never appends to a failed one's rows. Replaced
  and abandoned generations are deleted later, 8 MB at a time.
- A link continues a stored stream only when the server answers `+CONTINUE` for the offset after its last stored
  byte; the server checks its replication history, so a wrong guess costs a full sync, never a gap.
- A restored server continues from its own history after the replay; the generation's `shift` lines its offsets up
  with the stored stream.
- A running container is kept only if it answers and continues the stored stream exactly; one whose copy or replay was
  cut short can't, and is destroyed.
- The server keeps no data of its own (`save ""`, `appendonly no`): the object's storage is the only copy.

## Test

```sh
docker build --platform linux/amd64 -t vado-valkey --build-arg SERVER=valkey packages/box
BOX_IMAGE=vado-valkey BOX_SERVER=valkey npx vitest run packages/server/test/box
```

That runs the server in Docker through a full sync, the stream, a compaction, a continued stream after the link
drops, a server with another history refused, a restore from storage alone that continues from its own history, and a
restore from a bare base, each compared by `DEBUG DIGEST`. Without `BOX_IMAGE` it is skipped. `replay.test.ts` runs
without Docker.
