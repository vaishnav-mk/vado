# Build, deploy and operate

## Develop

Needs Node and `wrangler`. `npm install` brings in `workerd` and ioredis.

```sh
npm install
scripts/local.sh fresh      # build with wrangler, run workerd: TCP 127.0.0.1:6380, HTTP 127.0.0.1:8787
scripts/test-local.sh       # the whole local suite
```

`scripts/local.sh` takes `VALKEY_PASSWORD`, `ROUTER_SOCKET_BUDGET`, `ROUTER_IDLE_MS` and `BENCH_TOKEN` (default
`local`) from the environment, and keeps storage in `.local-do` unless you pass `fresh`. The local config
(`config.capnp.in`) has the `SHARD` to `SHARD7`, `REWRITER` to `REWRITER7`, `CATALOG` and `PULSE` bindings but no
`SENDER`, so bench `send` works only in
a deployment.

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
Lua atomicity, ordered pub/sub, large values, expiry, a 20k-command pipeline, connection churn), optionally with
`CHAOS=1` aborting shards underneath. Run it against local workerd or a deployment. `CHURN` sets how many
connections the churn check opens (default 200), and `ONLY=incr,queue` runs a subset.

The local suite doesn't exercise read replicas or Senders. Check those against a deployment with the bench probes
`staleness` and `ryw`, run from several regions with `send`.

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
| `LOCATION_HINT` | unset | Region for new shard objects (`apac`, `weur`, `enam`...) of databases without a `regions` list, and for every pub/sub shard |
| `VALKEY_MAXMEMORY` | `64mb` | Per shard and per replica. The isolate has 128 MB, so keep it at or under 64 MB |
| `VALKEY_MAXMEMORY_POLICY` | `noeviction` | `allkeys-lru` for a cache |
| `VALKEY_LOGLEVEL` | `warning` | Valkey's log level, written to the Worker's logs |
| `ROUTER_IDLE_MS` | `30000` | Idle shard sockets close after this |
| `ROUTER_SOCKET_BUDGET` | `128` | Shard and replica sockets per isolate before the router uses RPC batches |

Durable Object bindings, in `wrangler.jsonc`: `SHARD` to `SHARD7` (the eight shard classes: shards and their
replicas by class, with pub/sub and `__meta` in `SHARD`), `REWRITER` to `REWRITER7` (a shard class without its
rewriter binding rewrites its AOF inline, blocking), `CATALOG`, `PULSE` (optional: without it, routers don't report
activity and bench `pulse` returns nothing) and `SENDER` (needed only by bench `send`).

AOF rewrite thresholds (`AOF_REWRITE_MIN`, `AOF_REWRITE_IDLE_MS`, `AOF_REWRITE_CAP`), rewriter timeout and fallback
(`AOF_HELPER_TIMEOUT_MS`, `AOF_HELPER_RETRY_MS`), group commit (`SHARD_COMMITS`), shard classes (`SHARD_CLASSES`),
storage (`VFS_CHUNK`, `VFS_TAIL`, `VFS_SWEEP_BYTES`, `VFS_SWEEP_MS`), replication (`REPL_*`, `READ_YOUR_WRITES_MS`)
and the other tunables are in `src/constants.js`.

## Create a database with placement and replicas

Databases are created on first use with the epoch's shard count, at `LOCATION_HINT`. To choose the shard count,
the placement or replicas, create the database through the bench API before anyone uses it:

```sh
curl -H "authorization: Bearer $TOKEN" \
  "https://<your-worker>.workers.dev/db?db=mydb&shards=16&regions=world&replicas=world"
```

`regions` and `replicas` take `world` or a comma-separated list of location hints ([placement](scaling.md#placement)).
`classes=<1..8>` (default 8) sets how many shard classes the shards rotate over
([shard classes](scaling.md#shard-classes-and-isolates)); it is there for experiments. These apply only to a new
database; for an existing one, `/db` returns its record unchanged. `/db` on a database with replicas also
(re)starts them on every primary, which is safe to repeat. Replica state and lag are in `/stats` (`replicas` on
each shard: `ready`, `catching up`, `copying` or `idle`, with `lagMs` and `behindBytes`). Each shard's `isolate`
is an id per isolate, so shards that share one show the same id, and `lastRewrite` is its last helper rewrite: phase
times, bytes, any error and `doneMs`.

## Watch it live

`ui/` is a local page for one database: health, commands per second (replica reads included), response time
measured from your computer, keys and memory, each shard and replica with where it runs, and a map of where traffic
enters Cloudflare. It can also create databases (1, 4, 16 or 64 shards, in one region or around the world, with or
without replicas in every region), start test traffic from Sender objects in one region or all, restart a shard,
and run a command.

```sh
npm install                     # ioredis, which ui/server.mjs uses
npm --prefix ui install
npm --prefix ui run build       # Vite + React + @cloudflare/kumo, into ui/dist
VADO_URL=https://<your-worker>.workers.dev TOKEN=<bench token> HOST=<your-host> PORT=6379 PW=<password> DB=mydb \
  npm run ui                    # then open http://127.0.0.1:4040
```

`ui/server.mjs` keeps the bench token and password in its own process and listens on 127.0.0.1 only (`UI_PORT`
changes the port). It polls bench `shards` and `pulse` once a second, measures GET and SET times over TCP to
`HOST:PORT` (a TCP Worker, or `scripts/ws-shim.mjs` on 127.0.0.1), and streams a snapshot a second to the page.
Test traffic needs the `SENDER` binding.

## The bench API

`https://<your-worker>.workers.dev/<test>?...` with `Authorization: Bearer <BENCH_TOKEN>`. Every test takes `db`
(default `default`) and `via=router` (default) or `via=shard&shard=<i>` to skip the router.

| Test | What it does |
| --- | --- |
| `db` | Create a database, or return its record: `shards`, `regions`, `replicas`, `classes` |
| `dbs` | Every database's record |
| `stats`, `shards` | Each shard's host stats, files and replica states; `shards` adds Valkey's INFO for every shard and replica (the live view) |
| `pulse` | Each isolate's open connections, as last reported to the Pulse object |
| `throughput` | Pipelined SETs (`op=get` reads them back) over `conns` connections: `n`, `batch`, `value`, `keys=<m>` to reuse m keys per connection |
| `latency`, `conns`, `soak`, `fill`, `cpu`, `cpuSoak`, `idle`, `repeat`, `run`, `ioredis` | Latency, connection count, sustained load, memory, CPU and functional probes |
| `loadgen` | Runs `test` from `workers` separate invocations, so one isolate's CPU doesn't cap it |
| `send` | Runs `test` (default `throughput`) from a Sender object in `region`; `sender=<k>` picks one of several there |
| `durability`, `write`, `verify` | Write known keys, abort every shard (or deploy between `write` and `verify`), read them back |
| `abort` | Hard-reset one shard (`shard=<i>`) or all; `replica=<region>` resets that region's replicas instead |
| `commit` | How long shard 0's storage takes to confirm a write, from inside the object |
| `staleness` | How long after an acknowledged write a second connection still reads the old value |
| `ryw` | SET then GET the same key on one connection, `n` times; counts stale reads |
| `replicate` | Points every primary's replicas at `regions` (`none`, `world` or a list) without touching the catalog |
| `rpcbatch` | One RPC batch of `k` SETs straight to shard 0 (`par` at once); checks every reply came back |

`replicate` is a test hook. Routers still read from the replicas the catalog lists, and a replica its primary no
longer feeds keeps serving its last data until it resets. Don't use it on a database you care about.

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
HOST=<your-host> PORT=6379 PW=... DB=check node test/ioredis.mjs
```

`test/ioredis.mjs`, `test/resp3.mjs`, `test/chunked.mjs` and `test/hammer.mjs` take `HOST` and `PORT`.
`test/hammer.mjs` with `CHAOS=1` also needs `BASE` and `TOKEN`, since it aborts shards through the bench API.

## Upgrade safely

- Keep Durable Object RPC methods (`ValkeyShard`, `Catalog`, `Pulse`, `Sender`) and the rewriter's socket protocol
  stable. During a deploy, old routers call new objects, old primaries stream to new replicas, and old shards send
  rewrites to new rewriters.
- Change capacity by appending an epoch to `SHARD_EPOCHS`. Existing databases keep their shard count.
- The catalog adds its `regions` and `replicas` columns on startup when they are missing. Add later columns the same
  way, never by rewriting the table.
- New Durable Object classes need a new migration tag in `wrangler.jsonc`.
- Never remove a shard class. A database keeps shard `i` in class `i % classes` for life, and a build from before
  shard classes (df14748) sends every shard to `ValkeyShard`, where shards of newer databases outside class 0
  would be new, empty objects. Don't roll back past that change.
- Storing file rows under chunk keys (47d4c36) is a one-way change. Code from before it reads a file's rows by
  path, so it can't read any file created or renamed since, such as every AOF base and incr file written after the
  upgrade. Don't roll back past that change.
- Keep the rewriter classes in step with the shard classes: shard class `k` finds its rewriter by binding name
  (`SHARD<k>` uses `REWRITER<k>`).
- Changes to Valkey go in `wasm/patches/` or `wasm/wasi/`. Rebuild `vendor/valkey.wasm` with `wasm/build.sh` and
  wasi-sdk (`wasm/README.md`).
