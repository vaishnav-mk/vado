# vado

Valkey, or Redis, on Cloudflare Durable Objects.

Each shard is a Durable Object running real Valkey 9.1, compiled to WebAssembly, with its append-only file in the
object's SQLite. A router in the Worker spreads keys over the shards by hash slot, so `valkey-cli`, ioredis and
`valkey-benchmark` see one ordinary server. One Worker carries the database and a live dashboard.

Experimental. An independent project, not an official Cloudflare or Valkey product.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vaishnav-mk/vado)

![The dashboard watching a 64-shard database with a read replica of every shard in every region](docs/images/dashboard.jpg)

## What you get

- Real Valkey: its commands, replies and errors. Clients connect over TCP, a WebSocket or a service binding.
- Durable writes: a reply leaves only after its AOF entry is committed to SQLite.
- Shards in the regions you pick, with read replicas in other regions if you want them. A connection always reads
  its own writes, and `WAIT` counts the replicas that have them.
- Deploys that fail no commands: shards restart onto new code after answering what they have read.
- A password per database, and databases that can be dropped for good.
- A dashboard at the Worker's URL: shards, replicas on a globe, where traffic enters, response times and a timeline.
  Anyone can watch; people you let in through Cloudflare Access can create databases, run commands and restart shards.

## Set up

First create the Access application ([sign in](#sign-in)). Then press **Deploy to Cloudflare** above: it copies this
repo into your GitHub account, asks for `VALKEY_PASSWORD`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, builds and deploys.
The Worker's URL is the dashboard.

Or from a checkout:

```sh
npm install
npx wrangler secret put VALKEY_PASSWORD   # what clients send with AUTH <database> <password>
npm run deploy -- --var ACCESS_TEAM_DOMAIN:https://<team>.cloudflareaccess.com --var ACCESS_AUD:<tag>
```

Locally, `cp .dev.vars.example .dev.vars && npm run dev` serves it at http://localhost:5173.

## Connect

The username picks the database; a new one is created on first use.

```sh
npx vado-shim wss://<your-worker>.workers.dev/ws 6379          # from a checkout: a local TCP port for any client
valkey-cli -p 6379 --user mydb --pass "$VALKEY_PASSWORD"
```

From another Worker, bind this one (`"services": [{ "binding": "VALKEY", "service": "vado" }]`) and call
`env.VALKEY.connect("mydb:6379")`, or use ioredis with `bindingConnector` from [`packages/client`](packages/client).
For raw TCP from outside Cloudflare, put [Spectrum](docs/operations.md#tcp) in front.

## Sign in

Watching is public; changes need signing in with [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).
In Zero Trust, add a **self-hosted** application for the Worker's hostname with the path `signin`, and a policy that
allows you. Its audience tag is `ACCESS_AUD`; your team domain (`https://<team>.cloudflareaccess.com`) is
`ACCESS_TEAM_DOMAIN`. Protecting only `/signin` keeps the WebSockets (`/live`, `/ws`) open; the Worker checks the
Access JWT on every change.

## Redis

A database can run Redis 8.12 instead of Valkey, chosen when it is created. Redis's wasm doubles the upload and is
distributed under the AGPLv3, so it is in the build only with `VADO_REDIS=1 npm run deploy`.

## Limits

- 64 MB of data per shard and about 8 MB per request. Shard count, regions and replicas are fixed at creation.
- Multi-key commands across slots get `CROSSSLOT`, as in Valkey Cluster, except MGET, MSET, DEL, UNLINK, EXISTS and
  TOUCH, which the router splits. Use `{hashtags}`, or a 1-shard database.
- A command in flight when its shard resets gets `ERR shard connection lost; the command may or may not have run`.
- A replica read can miss another connection's write for one replication lag, unless the writer `WAIT`s.
- No ACLs; `CONFIG SET` takes only settings that change how data behaves.

More in [scaling](docs/scaling.md), [durability](docs/durability.md) and [security](docs/security.md).

## Repository

| Path | What |
| --- | --- |
| [`src/`](src) | The Worker's entry (`server.ts`) and the dashboard (TanStack Start, React, Kumo) |
| [`packages/server`](packages/server) | The database: router, shards, replication, catalog, the dashboard's backend and the bench API |
| [`packages/client`](packages/client) | ioredis over a service binding, and the WebSocket-to-TCP shim |
| [`packages/wasm`](packages/wasm) | Valkey and Redis built to wasm: patches, build scripts and the committed binaries CI rebuilds |
| [`test/`](test) | End-to-end tests against a running Worker |
| [`docs/`](docs) | [Architecture](docs/architecture.md), [life of a command](docs/lifecycle.md), [operations](docs/operations.md), [measurements](docs/measurements.md) |

`npm run check` lints, formats and type-checks; `npm test` runs the unit tests. Rules for changing the code are in
[AGENTS.md](AGENTS.md).

## License

[Apache-2.0](LICENSE). `valkey.wasm` is a build of Valkey and valkey-wasm, both BSD-3-Clause; `redis.wasm` is a build
of Redis 8, distributed under the AGPLv3. See [NOTICE](NOTICE).
