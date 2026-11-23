# vado

Valkey, or Redis, on Cloudflare Durable Objects.

Each shard is a Durable Object running the real server, Valkey 9.1 or Redis 8.12, compiled to WebAssembly, with its
append-only file in the object's SQLite. A router in the Worker spreads keys over the shards by hash slot, so
`valkey-cli`, `redis-cli`, ioredis and `valkey-benchmark` see one ordinary server. The same Worker serves a live
dashboard.

Experimental. An independent project, not an official Cloudflare or Valkey product.

**[Documentation](https://vado-docs.vaishnav.one)**: [quick start](https://vado-docs.vaishnav.one/docs/quick-start),
[architecture](https://vado-docs.vaishnav.one/docs/architecture), [durability](https://vado-docs.vaishnav.one/docs/durability),
[operations](https://vado-docs.vaishnav.one/docs/operations), [limits](https://vado-docs.vaishnav.one/docs/measurements),
[Redis](https://vado-docs.vaishnav.one/docs/redis), [WebAssembly builds](https://vado-docs.vaishnav.one/docs/wasm).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vaishnav-mk/vado)

![The dashboard watching a 64-shard database with a read replica of every shard in every region](apps/docs/public/dashboard.jpg)

## Quick start

1. Press **Deploy to Cloudflare**. It asks for `VALKEY_PASSWORD`, the password clients send with AUTH. The Worker's URL
   is the dashboard.
2. Connect. The username picks the database; a new one is created on first use.

```sh
npx vado-shim wss://<your-worker>.workers.dev/ws 6379
valkey-cli -p 6379 --user mydb --pass "$VALKEY_PASSWORD"
```

From a checkout: `npm install`, then `npm run deploy`, or `npm run dev` for http://localhost:5173.

## Valkey or Redis

A database picks its server when it's created and keeps it. Both get the same router, sharding, read replicas and
durability, and the same clients work with either.

- **Valkey 9.1** is in every build, and a database created on first use runs it.
- **Redis 8.12** is opt-in: deploy with `VADO_REDIS=1 npm run deploy`, then create a Redis database in the dashboard's
  New database dialog, or with `flavour=redis` on the bench API. The Deploy to Cloudflare button builds Valkey only.

`redis.wasm` is under the AGPLv3, which applies to a Worker that carries it
([what that asks of you](https://vado-docs.vaishnav.one/docs/redis)).

## Repository

| Path | What |
| --- | --- |
| [`apps/dashboard`](apps/dashboard) | The dashboard and the Worker's entry; `wrangler.jsonc` at the root is its config |
| [`apps/docs`](apps/docs) | The documentation site |
| [`packages/server`](packages/server) | The database: router, shards, replication, catalog, the dashboard's backend |
| [`packages/client`](packages/client) | ioredis over a service binding, and `vado-shim` |
| [`packages/wasm`](packages/wasm) | Valkey and Redis built to wasm |
| [`test`](test) | End-to-end tests; `test/e2e.sh` runs them against a deployment |

`npm run check` formats, lints and type-checks, `npm test` runs the unit tests, and `npm run docs` serves the
documentation. Changing the code: [AGENTS.md](AGENTS.md) and [repository](https://vado-docs.vaishnav.one/docs/repository).

## License

[Apache-2.0](LICENSE). `valkey.wasm` is a build of Valkey and valkey-wasm, both BSD-3-Clause; `redis.wasm` is a build
of Redis 8, under the AGPLv3, and only in builds made with `VADO_REDIS=1`. See [NOTICE](NOTICE).
