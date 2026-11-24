# vado

Valkey or Redis on Cloudflare Durable Objects. Each shard is a Durable Object running the real server, compiled to
WebAssembly or in a container beside it. A router in the Worker spreads keys over the shards by hash slot, and the same
Worker serves a dashboard.

This is an experiment. Don't keep data in it that you can't lose.

**[Documentation](https://vado-docs.vaishnav.one)** ·
[Differences from one server](https://vado-docs.vaishnav.one/docs/sharding#differences) ·
[Limits](https://vado-docs.vaishnav.one/docs/measurements)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vaishnav-mk/vado)

![The dashboard watching a 64-shard database with a read replica of every shard in every region](apps/docs/public/dashboard.jpg)

## Quick start

On Workers Paid, press **Deploy to Cloudflare** and set `VALKEY_PASSWORD`. The username picks the database, and a
database is created on its first AUTH. From a checkout, the shim gives any client a local port (Node 22 or newer):

```sh
node packages/client/ws-shim.mjs wss://<your-worker>.workers.dev/ws 6379
valkey-cli -p 6379 --user mydb --pass "$VALKEY_PASSWORD"
```

To deploy a checkout instead: `npm install`, `npx wrangler secret put VALKEY_PASSWORD`, `npm run deploy`.

## Flavours

| | WebAssembly, in the Durable Object | Native, in a container |
| --- | --- | --- |
| Valkey 9.1.1 | `valkey`, the default | `valkey-native` |
| Redis 8.12.0 | `redis` | `redis-native` |
| A shard holds | 64 MB; free while idle; read replicas | 2 GB; about $0.04 an hour while running |
| Build with | `VADO_REDIS=1` for Redis | `VADO_CONTAINERS=1`, and Docker |

The Deploy button builds Valkey in WebAssembly only. Other flavours, more shards and replicas are picked when a
database is created, through the [bench API](https://vado-docs.vaishnav.one/docs/operations#create). Its
`BENCH_TOKEN` can do anything to any database, so leave it unset unless you need it. Redis is under the AGPLv3
([what that asks of you](https://vado-docs.vaishnav.one/docs/flavours#licence)).

## Develop

`npm run check` formats, lints and type-checks; `npm test` runs the unit tests; `npm run dev` serves the Worker at
http://localhost:5173 (copy `.dev.vars.example` to `.dev.vars` first); `npm run docs` serves the documentation.
[AGENTS.md](AGENTS.md) has the layout and the rules.

| Path | What |
| --- | --- |
| [`apps/dashboard`](apps/dashboard) | The dashboard and the Worker's entry |
| [`apps/docs`](apps/docs) | The documentation site |
| [`packages/server`](packages/server) | Router, shards, replication, catalog |
| [`packages/client`](packages/client) | ioredis over a service binding, and the WebSocket shim |
| [`packages/wasm`](packages/wasm) | Valkey and Redis built to WebAssembly |
| [`packages/box`](packages/box) | The container image for the native flavours |
| [`test`](test) | End-to-end tests (`test/e2e.sh`) |

## License

[Apache-2.0](LICENSE). `valkey.wasm` is a build of Valkey and valkey-wasm (BSD-3-Clause). `redis.wasm` is a build of
Redis 8 (AGPLv3), included in the Worker only with `VADO_REDIS=1`. See [NOTICE](NOTICE).
