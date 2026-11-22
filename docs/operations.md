# Build, deploy and operate

## Develop

Needs Node 22 or later.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev                 # the Worker on http://localhost:5173 (vp dev: Vite with the Cloudflare plugin)
npm run check               # format, lint, type-check (vp check, then tsrs --noEmit --fast)
npm test                    # unit tests (vp test)
npm run build               # the Worker (vp build)
```

The root is the Worker: `src/server.ts` is its entry and `vite.config.ts` builds it. The database is the
`@vado/server` workspace package; the page imports its plain modules (regions, slots, views) instead of copying them.
`vp dev` has no TCP port; reach the local Worker with `npx vado-shim ws://localhost:5173/ws 6379`.

## Tests

| Test | What must hold |
| --- | --- |
| `packages/server/src/protocol/resp.test.ts` | The RESP parser: requests and replies in pieces parse as whole ones, and 200k arguments in 1 KB pieces stay linear |
| `packages/server/src/admin/access.test.ts` | Only a valid Cloudflare Access JWT for the configured team and audience signs in |
| Other `packages/server/src/**/*.test.ts` | The VFS and its WASI calls, the shard host, reply order and the router's own replies, key slots, epochs, placement and replica names, the catalog's old-table upgrade, the isolate cache, and the Watcher's events and state |
| `src/lib/lib.test.ts` | The page's command parsing and reply display |
| `test/ioredis.mjs` | Stock ioredis: MULTI, Lua, BLPOP, streams, pub/sub, pipelining, expiry |
| `test/resp3.mjs` | HELLO 3, maps and pushes |
| `test/chunked.mjs` | Requests split into 1-byte to 4 KB writes reassemble exactly; an 8 MB value in 4 KB pieces parses in linear time |
| `test/watch-reset.mjs` | A shard reset between WATCH and EXEC aborts the transaction |
| `test/differential.mjs` | The same random command stream gives identical replies on a 1-shard and an N-shard database |
| `test/deploy.mjs` | Connections kept busy through a deploy lose no acknowledged write |

The first four rows are unit tests (`npm test`). The `test/` ones run against a Worker: `HOST` and `PORT` (default
127.0.0.1:6379, a `vado-shim` port), `PW` and `DB`, and `BASE` and `TOKEN` for the ones that use the bench API.
`test/e2e.sh` runs them all on fresh databases, with the bench durability, replica and drop checks; its header
lists the variables. CI runs it on every push to `main` once it is turned on ([README](../README.md#develop-and-test)).

`test/hammer.mjs` checks concurrency invariants (exact INCR, conserved WATCH/MULTI transfers, a lossless queue,
Lua atomicity, ordered pub/sub, large values, expiry, a 20k-command pipeline, connection churn), optionally with
`CHAOS=1` aborting shards underneath. `CHURN` sets how many connections the churn check opens (default 200), and
`ONLY=incr,queue` runs a subset. Replicas and Senders need a deployment: check them with the bench probes
`staleness` and `ryw`, run from several regions with `send`.

## Deploy

```sh
npx wrangler secret put VALKEY_PASSWORD
npx wrangler secret put BENCH_TOKEN    # optional: enables the bench API
npm run deploy -- --var ACCESS_TEAM_DOMAIN:https://<team>.cloudflareaccess.com --var ACCESS_AUD:<tag>
                                       # vp build, then wrangler deploy; VADO_REDIS=1 to carry Redis
```

Connections that are open during a deploy keep the old router code until they end. Busy shards restart onto the new
code within about 30 s, without failing commands, and their replicas follow ([during a deploy](durability.md#during-a-deploy));
idle ones get it when they next start. Wait a minute after a deploy before you measure anything.

## Configure

| Var | Default | Meaning |
| --- | --- | --- |
| `VALKEY_PASSWORD` (secret) | unset | Makes AUTH mandatory and enables `/ws` |
| `BENCH_TOKEN` (secret) | unset | Bearer token for the bench API (`packages/server/src/bench/bench.ts`); unset disables it |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | required | Sign-in to the dashboard with Cloudflare Access: the team domain and the application's audience tag ([README](../README.md#sign-in)) |
| `SHARD_EPOCHS` | `[{"from":0,"shards":1}]` | Shard count by database creation time, `[{ from, shards }]` in ms. Append, never edit |
| `LOCATION_HINT` | unset | Region for new shard objects (`apac`, `weur`, `enam`...) of databases without a `regions` list, and for every pub/sub shard |
| `VALKEY_MAXMEMORY` | `64mb` | Per shard; replicas follow their primary and have no limit of their own. The isolate has 128 MB, so keep it at or under 64 MB |
| `VALKEY_MAXMEMORY_POLICY` | `noeviction` | `allkeys-lru` for a cache |
| `VALKEY_LOGLEVEL` | `warning` | Valkey's log level, written to the Worker's logs |
| `ROUTER_IDLE_MS` | `30000` | Idle shard sockets close after this |
| `ROUTER_SOCKET_BUDGET` | `128` | Shard and replica sockets per isolate before the router uses RPC batches |

Durable Object bindings, in `wrangler.jsonc`: `SHARD` to `SHARD7` (the eight shard classes, with pub/sub and
`__meta` in `SHARD`), `SHARD8` to `SHARD15` (read replicas: `SHARD{8 + k}` holds the replicas of class `k`), `REWRITER` to `REWRITER7` (shard class `k` uses
`REWRITER<k>`), `CATALOG`, `PULSE` (routers report their open connections to it, and Watchers read it), `WATCHER`
(`/live`) and `SENDER` (bench `send` and the dashboard's test traffic). `AUTH_LIMIT` is a rate limiting binding for
failed AUTHs per client address ([security](security.md#authentication)). All of them are required.

AOF rewrite thresholds (`AOF_REWRITE_MIN`, `AOF_REWRITE_IDLE_MS`, `AOF_REWRITE_CAP`), rewriter timeout and fallback
(`AOF_HELPER_TIMEOUT_MS`, `AOF_HELPER_RETRY_MS`), group commit (`SHARD_COMMITS`), shard classes (`SHARD_CLASSES`),
storage (`VFS_CHUNK`, `VFS_TAIL`, `VFS_SWEEP_BYTES`, `VFS_SWEEP_MS`), replication (`REPL_*`, `READ_YOUR_WRITES_MS`)
and the other tunables are in each directory's `config.ts` under `packages/server/src/`: `router/`, `shard/`,
`shard/host/`, `shard/vfs/`, `replication/` and `admin/`.

## Create a database with placement and replicas

Databases are created on first use with the epoch's shard count, at `LOCATION_HINT`. To choose the shard count,
the placement or replicas, create the database through the bench API before anyone uses it:

```sh
curl -H "authorization: Bearer $TOKEN" \
  "https://<your-worker>.workers.dev/db?db=mydb&shards=16&regions=world&replicas=world"
```

`regions` and `replicas` take `world` or a comma-separated list of location hints ([placement](scaling.md#placement)).
`flavour=redis` runs Redis 8.12 instead of Valkey ([flavours](architecture.md#flavours)); the dashboard's New
database dialog has the same choice.
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
Anyone can watch. Signed in with Cloudflare Access, you can also create databases (1, 4, 16 or 64 shards, in one
region or around the world, with or without replicas in every region), run a command and see which shard and
replica handled it, restart a shard, and start test traffic from Sender objects in one region or all. Test traffic
stops by itself after 10 minutes, and its keys are sized to the database (50,000 per shard, `TEST_KEYS_PER_SHARD`),
so it never fills a small one.

How it fits together:

- The dashboard (`src/`: TanStack Start, React, `@cloudflare/kumo`) serves every request that isn't TCP, `/ws`,
  `/live` or a bench call. It loads on the first page request, so shards and replicas never start it.
- The page's live numbers come from `/live?db=<name>`, a WebSocket from that database's Watcher object
  (`packages/server/src/admin/watcher/watcher.ts`). It polls every shard and ready replica once a second while anyone watches,
  measures response time on connections of its own (from wherever the Watcher runs, which the page says), and stops
  when nobody watches.
- Everything else goes through the dashboard's server functions to `Admin` (`packages/server/src/admin/admin.ts`) in
  the same Worker. Every change first checks the Access JWT (`packages/server/src/admin/access.ts`).

## The bench API

`https://<your-worker>.workers.dev/<test>?...` with `Authorization: Bearer <BENCH_TOKEN>`. Every test takes `db`
(default `default`) and `via=router` (default: a router in the same isolate) or `via=shard&shard=<i>` to skip it.

| Test | What it does |
| --- | --- |
| `db` | Create a database, or return its record: `shards`, `regions`, `replicas`, `classes`, and `password=new` to give a new database its own password (returned once, in `password`) |
| `stats`, `shards` | Each shard's host stats, files and replica states; `shards` adds Valkey's INFO for every shard and each ready replica |
| `throughput` | Pipelined SETs (`op=get` reads them back) over `conns` connections: `n`, `batch`, `value`, `keys=<m>` to reuse m keys per connection |
| `latency` | One PING, then `n` GETs (default 200) one at a time: the first reply and p50, p99 and max |
| `fill` | Writes `value`-byte strings (default 64 KB) until Valkey refuses with OOM or a connection dies |
| `run` | Runs the commands in a POSTed JSON array, such as `[["SET","k","v"],["GET","k"]]` |
| `ioredis` | Stock ioredis inside the Worker, through `bindingConnector` to a router in the same isolate |
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
| `drop` | Drop a database for good. The catalog marks it dropped, so its name (and its shards' names) is never reused; every shard and the pub/sub shard deletes its storage and keeps only a tombstone that refuses to boot, and the primaries retire their replicas. A router that cached the database's record gets `ERR database <name> was dropped` from its shards, never an empty database, and forgets the record, so its next connection is refused at AUTH |
| `churn` | Connection churn from inside Cloudflare, through the router's own connect handler with no TCP ingress in between: `n` connections (default 2,000), `par` at a time (50), each AUTH, SET, GET and close. Reports failures with their errors |
| `vfs` | Writes two `mb` MB files (default 32) to shard 0's storage, then deletes the first, now in the middle of the database, and then the second, at its end, with each step's storage commit time |

`replicate` is a test hook. Routers still read from the replicas the catalog lists, and a replica its primary no
longer feeds keeps serving its last data until it resets. Don't use it on a database you care about.

## Reach it

- **From a Worker:** a service binding to this Worker, then `env.VALKEY.connect("<db>:6379")` for raw RESP, or
  ioredis with `bindingConnector` from `@vado/client` (`packages/client`).
- <a id="tcp"></a>**Over TCP:** a Spectrum application of type Workers (tcp) with this Worker as origin, on port 6379.
  Turn on TLS (`flexible`). Spectrum doesn't pass the hostname, so clients pick the database with
  `AUTH <db> <password>`.
- **Over WebSocket:** `npx vado-shim wss://<your-worker>.workers.dev/ws 6379`, then point any client at
  127.0.0.1:6379.

## Upgrade safely

- Keep Durable Object RPC methods (`ValkeyShard`, `Catalog`, `Pulse`, `Sender`, `Watcher`) and the rewriter's socket protocol
  stable. During a deploy, old routers call new objects, old primaries stream to new replicas, and old shards send
  rewrites to new rewriters.
- Change capacity by appending an epoch to `SHARD_EPOCHS`. Existing databases keep their shard count.
- Each object's tables come from its `migrations.ts` list, applied on startup and recorded in
  `durability_migrations`. Add a column with a new migration, never by editing a shipped one or rewriting the table,
  and never rename a table or column.
- New Durable Object classes need a new migration tag in `wrangler.jsonc`.
- Never remove a shard class. A database keeps shard `i` in class `i % classes` for life, and a build from before
  shard classes (df14748) sends every shard to `ValkeyShard`, where shards of newer databases outside class 0
  would be new, empty objects. Don't roll back past that change.
- Storing file rows under chunk keys (47d4c36) is a one-way change. Code from before it reads a file's rows by
  path, so it can't read any file created or renamed since, such as every AOF base and incr file written after the
  upgrade. Don't roll back past that change.
- Keep the rewriter classes in step with the shard classes: shard class `k` finds its rewriter by binding name
  (`SHARD<k>` uses `REWRITER<k>`).
- Changes to a server go in its patches (`packages/wasm/valkey/patches/`, `packages/wasm/redis/patches/`) or the
  shared `packages/wasm/wasi/`. Rebuild with that server's `build.sh` and wasi-sdk ([packages/wasm](../packages/wasm/README.md)).
