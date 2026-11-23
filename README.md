# vado

Valkey, or Redis, on Cloudflare Durable Objects.

Each shard is a Durable Object running the upstream server, Valkey 9.1.1 or Redis 8.12.0, compiled to WebAssembly
with the fewest changes that let it run on Workers. Its append-only file lives in the object's SQLite, and read
replicas stream it to other regions. A router in the Worker spreads keys over the shards by hash slot. Most commands
run in the server; the router answers connection, cross-shard and admin commands
([differences](https://vado-docs.vaishnav.one/docs/sharding#differences)). The same Worker serves a live dashboard.

This is just an independent, fancy experiment. Don't keep data in it that you can't lose.

**[Documentation](https://vado-docs.vaishnav.one)**: [quick start](https://vado-docs.vaishnav.one/docs/quick-start),
[architecture](https://vado-docs.vaishnav.one/docs/architecture), [durability](https://vado-docs.vaishnav.one/docs/durability),
[operations](https://vado-docs.vaishnav.one/docs/operations), [costs](https://vado-docs.vaishnav.one/docs/operations#costs),
[limits](https://vado-docs.vaishnav.one/docs/measurements), [Redis](https://vado-docs.vaishnav.one/docs/redis),
[WebAssembly builds](https://vado-docs.vaishnav.one/docs/wasm).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vaishnav-mk/vado)

![The dashboard watching a 64-shard database with a read replica of every shard in every region](apps/docs/public/dashboard.jpg)

## Quick start

The docs assume Workers Paid.

1. Press **Deploy to Cloudflare**. It asks for `VALKEY_PASSWORD`, the password clients send with AUTH. The Worker's URL
   is the dashboard, which watches databases.
2. Connect. The username picks the database. A database is created on its first AUTH, with 1 shard, Valkey and no
   replicas.

From a checkout, after `npm install`, the shim gives any client a local TCP port. It needs Node 22 or newer:

```sh
node packages/client/ws-shim.mjs wss://<your-worker>.workers.dev/ws 6379
valkey-cli -p 6379 --user mydb --pass "$VALKEY_PASSWORD"
```

To deploy from a checkout:

```sh
npm install
npx wrangler secret put VALKEY_PASSWORD
npm run deploy
```

For `npm run dev` (http://localhost:5173), copy `.dev.vars.example` to `.dev.vars` and set the password in it.

## Valkey or Redis

A database picks its server when it's created and keeps it. Both get the same router, sharding, read replicas and
durability, and the same clients work with either.

- **Valkey 9.1.1** is in every build, and a database created on first use runs it.
- **Redis 8.12.0** is opt-in: deploy with `VADO_REDIS=1 npm run deploy`, then create the database with
  `flavour=redis` on the [bench API](https://vado-docs.vaishnav.one/docs/operations#create). The Deploy to Cloudflare
  button builds Valkey only.

More shards, replicas or Redis go through the bench API, which needs `npx wrangler secret put BENCH_TOKEN` first:

```sh
curl -H "authorization: Bearer $BENCH_TOKEN" "https://<your-worker>.workers.dev/db?db=cache&shards=16&flavour=redis"
```

`BENCH_TOKEN` can do anything to any database. Keep it unset unless you need it.

`redis.wasm` is under the AGPLv3, which applies to a Worker that carries it
([what that asks of you](https://vado-docs.vaishnav.one/docs/redis)).

## Repository

| Path | What |
| --- | --- |
| [`apps/dashboard`](apps/dashboard) | The dashboard and the Worker's entry; `wrangler.jsonc` at the root is its config |
| [`apps/docs`](apps/docs) | The documentation site |
| [`packages/server`](packages/server) | The database: router, shards, replication, catalog, the dashboard's backend |
| [`packages/client`](packages/client) | ioredis over a service binding, and the WebSocket shim (`ws-shim.mjs`) |
| [`packages/wasm`](packages/wasm) | Valkey and Redis built to wasm |
| [`test`](test) | End-to-end tests; `test/e2e.sh` runs them against a deployment |

`npm run check` formats, lints and type-checks, `npm test` runs the unit tests, and `npm run docs` serves the
documentation. Changing the code: [AGENTS.md](AGENTS.md) and [repository](https://vado-docs.vaishnav.one/docs/repository).

## License

[Apache-2.0](LICENSE). `valkey.wasm` is a build of Valkey and valkey-wasm, both BSD-3-Clause. `redis.wasm` is a build
of Redis 8, under the AGPLv3. The repository ships it, and the Worker includes it only in builds made with
`VADO_REDIS=1`. See [NOTICE](NOTICE).
