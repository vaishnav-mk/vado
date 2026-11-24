# Valkey and Redis in containers (experimental)

The `valkey-native` and `redis-native` flavours run unmodified Valkey 9.1.1 or Redis 8.12.0 in a Cloudflare Container
beside each shard's Durable Object. Build with `VADO_CONTAINERS=1`. Design, limits and measurements are on the docs
site's [Flavours](https://vado-docs.vaishnav.one/docs/flavours) page.

`Dockerfile` builds one server (`--build-arg SERVER=valkey|redis`) from the same pinned tarballs as `packages/wasm`,
plus netcat, which a restore uses to take the stored RDB.

## Code (`packages/server/src/box/`)

| File | What |
|---|---|
| `box.ts` | `RedisBox`, the shard's Durable Object for either server |
| `engine.ts` | The running container: compaction, pruning, idle stop |
| `attach.ts` | Where a stored stream resumes, and opening the replica link |
| `container.ts` | Starting, reusing and restoring a container |
| `server.ts` | The server in it: readiness, replay, replication history |
| `link.ts`, `rdb.ts` | The replica link that stores the stream, and a full sync's RDB |
| `proxy.ts`, `mux.ts` | Client connections, with replies held until their writes are stored |
| `store.ts` | Generations of stored RDB and stream in SQLite |
| `config.ts`, `types.ts` | Timings and limits; shared types |

## Rules

- A reply leaves only once the replication stream up to its batch's `ROLE` offset is stored.
- A generation becomes current only once it holds everything the one before it does, and its number is never reused.
- A link continues a stored stream only when the server answers `+CONTINUE`; otherwise it takes a full sync.
- The server keeps no data of its own: the object's storage is the only copy.

## Test

```sh
docker build --platform linux/amd64 -t vado-valkey --build-arg SERVER=valkey packages/box
BOX_IMAGE=vado-valkey BOX_SERVER=valkey npx vitest run packages/server/test/box
```

Without `BOX_IMAGE` the Docker tests are skipped; the others run with `npm test`.
