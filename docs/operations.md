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
(`config.capnp.in`) has the `SHARD` to `SHARD15`, `REWRITER` to `REWRITER7`, `CATALOG` and `PULSE` bindings but no
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
| `BENCH_TOKEN` (secret) | unset | Bearer token for the bench API (`src/bench/bench.js`); unset disables it |
| `SHARD_EPOCHS` | `[{"from":0,"shards":16}]` | Shard count by database creation time, `[{ from, shards }]` in ms. Append, never edit |
| `LOCATION_HINT` | unset | Region for new shard objects (`apac`, `weur`, `enam`...) of databases without a `regions` list, and for every pub/sub shard |
| `VALKEY_MAXMEMORY` | `64mb` | Per shard; replicas follow their primary and have no limit of their own. The isolate has 128 MB, so keep it at or under 64 MB |
| `VALKEY_MAXMEMORY_POLICY` | `noeviction` | `allkeys-lru` for a cache |
| `VALKEY_LOGLEVEL` | `warning` | Valkey's log level, written to the Worker's logs |
| `ROUTER_IDLE_MS` | `30000` | Idle shard sockets close after this |
| `ROUTER_SOCKET_BUDGET` | `128` | Shard and replica sockets per isolate before the router uses RPC batches |

Durable Object bindings, in `wrangler.jsonc`: `SHARD` to `SHARD7` (the eight shard classes, with pub/sub and
`__meta` in `SHARD`), `SHARD8` to `SHARD15` (read replicas: `SHARD{8 + k}` holds the replicas of class `k`), `REWRITER` to `REWRITER7` (a shard class without its
rewriter binding rewrites its AOF inline, blocking), `CATALOG`, `PULSE` (optional: without it, routers don't report
activity and bench `pulse` returns nothing) and `SENDER` (needed only by bench `send`). `AUTH_LIMIT` is a rate
limiting binding for failed AUTHs per client address ([security](security.md#authentication)); without it, AUTH
isn't rate limited.

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

The dashboard is the Worker's own URL: `https://<your-worker>.workers.dev/db/<name>`. It shows one database at a
time: health, commands per second (replica reads included), response time, keys, memory and the saved log, the
shard dial, a spinning globe with the shards, their replicas and where traffic enters, a board of every replica by
region and shard with its state and lag, each shard's details, and a timeline of restarts, deploys, log compactions and replica changes.
Anyone can watch. Signed in with the bench token, you can also create databases (1, 4, 16 or 64 shards, in one
region or around the world, with or without replicas in every region), run a command and see which shard and
replica handled it, restart a shard, and start test traffic from Sender objects in one region or all. Test traffic
stops by itself after 10 minutes, and its keys are sized to the database (50,000 per shard, `TEST_KEYS_PER_SHARD`),
so it never fills a small one.

How it fits together:

- `dashboard/` is its own Worker, `vado-dashboard` (TanStack Start, React, `@cloudflare/kumo`), with no URL of its
  own. This Worker forwards every request that isn't `/ws`, `/live` or a bench call to it (`DASHBOARD` binding).
- The page's live numbers come from `/live?db=<name>`, a WebSocket from that database's Watcher object
  (`src/admin/watcher.js`). It polls every shard and ready replica once a second while anyone watches, measures
  response time on connections of its own (from wherever the Watcher runs, which the page says), and stops when
  nobody watches.
- Everything else goes through the dashboard's server functions to this Worker's `Admin` RPC entrypoint
  (`src/admin/admin.js`), which checks the sign-in session on every change.

Deploy both Workers. They bind to each other, so on a new account deploy this one once without the `DASHBOARD`
service in `wrangler.jsonc`, then the dashboard, then this one with it:

```sh
npx wrangler deploy                                  # the database Worker
(cd dashboard && npm install && npm run deploy)      # vado-dashboard: vite build, then wrangler deploy
```

## The bench API

`https://<your-worker>.workers.dev/<test>?...` with `Authorization: Bearer <BENCH_TOKEN>`. Every test takes `db`
(default `default`) and `via=router` (default) or `via=shard&shard=<i>` to skip the router.

| Test | What it does |
| --- | --- |
| `db` | Create a database, or return its record: `shards`, `regions`, `replicas`, `classes`, and `password=new` to give a new database its own password (returned once, in `password`) |
| `dbs` | Every database's record |
| `stats`, `shards` | Each shard's host stats, files and replica states; `shards` adds Valkey's INFO for every shard and each ready replica |
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
| `frag` | Memory fragmentation on shard 0; run it with `via=shard`. Starts with FLUSHALL, writes `n` keys (default 150,000) with value sizes from `min` to `max` bytes (16-512), then `rounds` times (6) deletes a random half and writes it again with sizes from `min2` to `max2`. `seed` seeds the sizes, `type=hash` stores the values as fields of small hashes, `rand=1` makes them incompressible. Reports Valkey's `used_memory` and the wasm linear memory after each round |
| `rewrite` | BGREWRITEAOF on shard 0 while another connection PINGs it (`via=shard` PINGs the shard directly): the reply and total time, PING p50, p99 and max, the PINGs over 150 ms, the base file's size, and the shard's `lastRewrite` |
| `drop` | Drop a database for good. The catalog marks it dropped, so its name (and its shards' names) is never reused and it leaves `dbs`; every shard and the pub/sub shard deletes its storage and keeps only a tombstone that refuses to boot, and the primaries retire their replicas. A router that cached the database's record gets `ERR database <name> was dropped` from its shards, never an empty database, and forgets the record, so its next connection is refused at AUTH |
| `churn` | Connection churn from inside Cloudflare, through the router's own connect handler with no TCP ingress in between: `n` connections (default 2,000), `par` at a time (50), each AUTH, SET, GET and close. Reports failures with their errors |
| `vfs` | Writes two `mb` MB files (default 32) to shard 0's storage, then deletes the first, now in the middle of the database, and then the second, at its end, with each step's storage commit time |

`replicate` is a test hook. Routers still read from the replicas the catalog lists, and a replica its primary no
longer feeds keeps serving its last data until it resets. Don't use it on a database you care about.

## Reach it

- **From a Worker:** a service binding to this Worker, then `env.VALKEY.connect("<db>:6379")` for raw RESP, or
  ioredis with `bindingConnector` from `src/client/ioredis.js`.
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
- Changes to Valkey go in `wasm/patches/` or `wasm/wasi/`. Rebuild `wasm/valkey.wasm` with `wasm/build.sh` and
  wasi-sdk (`wasm/README.md`).
