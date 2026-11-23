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
[limits](https://vado-docs.vaishnav.one/docs/measurements), [flavours](https://vado-docs.vaishnav.one/docs/flavours),
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

## Flavours

A database picks its flavour when it's created and keeps it: Valkey or Redis, compiled to wasm inside each shard's
Durable Object, or unmodified in a container beside it. All four share the router, sharding and durability rules, and
the same clients work with any of them.

| | In the Durable Object (wasm) | In a container (native) |
| --- | --- | --- |
| **Valkey 9.1.1** | `valkey`, in every build | `valkey-native`, with `VADO_CONTAINERS=1` |
| **Redis 8.12.0** | `redis`, with `VADO_REDIS=1` | `redis-native`, with both |

A wasm shard holds 64 MB, sleeps for free and has read replicas. A container shard holds 2 GB; its object stays the
only durable copy, as a replica that stores the server's replication stream, and a reply leaves only once the writes
before it are stored. An idle container stops after 10 to 15 minutes and costs about $0.04 an hour while it runs.
Containers need Docker for the build and run on the `durable_object` scheduling policy, which is in beta. The Deploy to
Cloudflare button builds Valkey in wasm only.

A database created on first use runs Valkey in wasm. Other flavours, more shards or replicas go through the
[bench API](https://vado-docs.vaishnav.one/docs/operations#create), which needs `npx wrangler secret put BENCH_TOKEN`
first:

```sh
VADO_REDIS=1 VADO_CONTAINERS=1 npm run deploy
curl -H "authorization: Bearer $BENCH_TOKEN" "https://<your-worker>.workers.dev/db?db=cache&shards=16&flavour=valkey-native"
```

`BENCH_TOKEN` can do anything to any database. Keep it unset unless you need it.

Redis is under the AGPLv3, which applies to a Worker that carries it
([what that asks of you](https://vado-docs.vaishnav.one/docs/flavours#licence)).

## Repository

| Path | What |
| --- | --- |
| [`apps/dashboard`](apps/dashboard) | The dashboard and the Worker's entry; `wrangler.jsonc` at the root is its config |
| [`apps/docs`](apps/docs) | The documentation site |
| [`packages/server`](packages/server) | The database: router, shards, replication, catalog, the dashboard's backend |
| [`packages/client`](packages/client) | ioredis over a service binding, and the WebSocket shim (`ws-shim.mjs`) |
| [`packages/wasm`](packages/wasm) | Valkey and Redis built to wasm |
| [`packages/box`](packages/box) | The container image of Valkey or Redis, for the `-native` flavours |
| [`test`](test) | End-to-end tests; `test/e2e.sh` runs them against a deployment |

`npm run check` formats, lints and type-checks, `npm test` runs the unit tests, and `npm run docs` serves the
documentation. Changing the code: [AGENTS.md](AGENTS.md) and [repository](https://vado-docs.vaishnav.one/docs/repository).

## License

[Apache-2.0](LICENSE). `valkey.wasm` is a build of Valkey and valkey-wasm, both BSD-3-Clause. `redis.wasm` is a build
of Redis 8, under the AGPLv3. The repository ships it, and the Worker includes it only in builds made with
`VADO_REDIS=1`. See [NOTICE](NOTICE).
