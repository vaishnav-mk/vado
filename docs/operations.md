# Build, deploy and operate

## Develop

Needs Node and `wrangler`. `npm install` brings in `workerd` and ioredis.

```sh
npm install
scripts/local.sh fresh      # build with wrangler, run workerd: TCP 127.0.0.1:6380, HTTP 127.0.0.1:8787
scripts/test-local.sh       # the whole local suite
```

`scripts/local.sh` takes `VALKEY_PASSWORD`, `ROUTER_SOCKET_BUDGET`, `ROUTER_IDLE_MS` and `BENCH_TOKEN` (default
`local`) from the environment, and keeps storage in `.local-do` unless you pass `fresh`.

## Tests

`scripts/test-local.sh` runs all of these against local workerd:

| Test | What must hold |
| --- | --- |
| `test/ioredis.mjs` | Stock ioredis: MULTI, Lua, BLPOP, streams, pub/sub, pipelining, expiry |
| `test/resp3.mjs` | HELLO 3, maps and pushes |
| `test/chunked.mjs` | Requests split into 1-byte to 4 KB writes reassemble exactly; an 8 MB value in 4 KB pieces parses in linear time |
| `test/watch-reset.mjs` | A shard reset between WATCH and EXEC aborts the transaction |
| `test/differential.mjs` | The same random command stream gives identical replies on a 1-shard and an N-shard database |
| `test/kill9.mjs` | `kill -9` of the runtime mid-write keeps every acknowledged write |
| `test/auth.mjs` | The AUTH gate, database selection, size limits before AUTH, WebSocket ingress, idle socket close, rows per write |
| bench API without a token | Refused, whatever the `Authorization` header says |

`test/hammer.mjs` checks concurrency invariants (exact INCR, conserved WATCH/MULTI transfers, a lossless queue,
Lua atomicity, ordered pub/sub, large values, expiry, connection churn), optionally with `CHAOS=1` aborting shards
underneath. Run it against local workerd or a deployment.

## Deploy

```sh
wrangler secret put VALKEY_PASSWORD
wrangler secret put BENCH_TOKEN        # optional: enables the bench API
wrangler deploy
```

Connections that are open during a deploy keep the old router code until they end, and shards move to the new code
over minutes. Wait at least 5 minutes after a deploy before you measure anything.

## Configure

| Var | Default | Meaning |
| --- | --- | --- |
| `VALKEY_PASSWORD` (secret) | unset | Makes AUTH mandatory and enables `/ws` |
| `BENCH_TOKEN` (secret) | unset | Bearer token for the bench API (`src/bench.js`); unset disables it |
| `SHARD_EPOCHS` | `[{"from":0,"shards":16}]` | Shard count by database creation time, `[{ from, shards }]` in ms. Append, never edit |
| `LOCATION_HINT` | unset | Region for new shard objects (`apac`, `weur`, `enam`...) |
| `VALKEY_MAXMEMORY` | `64mb` | Per shard. The isolate has 128 MB, so keep it at or under 64 MB |
| `VALKEY_MAXMEMORY_POLICY` | `noeviction` | `allkeys-lru` for a cache |
| `VALKEY_AOF_REWRITE_MIN` | `8mb` | AOF size that allows an (inline) rewrite |
| `VALKEY_LOGLEVEL` | `warning` | Valkey's log level, written to the Worker's logs |
| `ROUTER_IDLE_MS` | `30000` | Idle shard sockets close after this |
| `ROUTER_SOCKET_BUDGET` | `128` | Shard sockets per isolate before the router uses RPC batches |

Other tunables are in `src/constants.js`.

## Reach it

- **From a Worker:** a service binding to this Worker, then `env.VALKEY.connect("<db>:6379")` for raw RESP, or
  ioredis with `bindingConnector` from `src/client.js`.
- **Over TCP:** a Spectrum application of type Workers (tcp) with this Worker as origin, on port 6379. Turn on TLS
  (`flexible`). Spectrum doesn't pass the hostname, so clients pick the database with `AUTH <db> <password>`.
- **Over WebSocket:** `node scripts/ws-shim.mjs wss://<your-worker>.workers.dev/ws 6379`, then point any client at
  127.0.0.1:6379.

## Test against a deployment

```sh
VADO_URL=https://<your-worker>.workers.dev TOKEN=... PW=... scripts/prod-hammer.sh
HOST=<app-hostname> PORT=6379 PW=... DB=check node test/ioredis.mjs
```

`test/ioredis.mjs`, `test/resp3.mjs`, `test/chunked.mjs` and `test/hammer.mjs` take `HOST` and `PORT`.
`test/hammer.mjs` with `CHAOS=1` also needs `BASE` and `TOKEN`, since it aborts shards through the bench API.

## Upgrade safely

- Keep Durable Object RPC methods (`ValkeyShard`, `Catalog`) stable. During a deploy, old routers call new objects.
- Change capacity by appending an epoch to `SHARD_EPOCHS`. Existing databases keep their shard count.
- New Durable Object classes need a new migration tag in `wrangler.jsonc`.
- Changes to Valkey go in `vendor/valkey-wasm.patch`. Rebuild `vendor/valkey.wasm` from valkey-wasm with the patch
  and wasi-sdk (`vendor/README.md`).
