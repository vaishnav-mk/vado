# Agent guide

Rules for anyone, human or agent, changing this repo. Paths starting `server/` are under `packages/server/src/`.

## Invariants

- **An acknowledged write is durable.** Valkey runs with `appendfsync always`, and the VFS writes AOF appends to SQLite
  synchronously, so the output gate holds a reply until its write is stored. Nothing may reply to a write before
  that, and nothing may buffer AOF bytes past a reply. Group commit (`SHARD_COMMITS`) may delay input, never a commit.
- **Replies leave in request order, per connection.** Socket upstreams keep per-shard order on their own. A command
  that goes by RPC (fan-out, SCAN, INFO, RPC batches) waits for every earlier reply (`ReplyQueue.afterEarlier` in
  `server/router/replies.ts`), and later requests wait for it (`replies.hold`). `replies.viaRpc` does both; a new
  RPC-path command must go through it, or use both by hand.
- **Replicas get only committed writes, and a connection reads a shard it wrote to from the primary for
  `READ_YOUR_WRITES_MS` (2 s).** It sees its own writes unless a replica is more than that behind. The replication stream
  (`Vfs.onAppend`) leaves through the primary's output gate; never send it any other way. A router path that writes
  must bracket the send with `writes.start`/`writes.done` (`ReadYourWrites` in `server/router/read-your-writes.ts`),
  so that connection reads the shard from its primary until `READ_YOUR_WRITES_MS` after the reply; a fan-out that
  writes counts for every shard (`writes.all`). Only retryable reads (read-only, non-blocking, outside MULTI/WATCH)
  may go to a replica, so a failed replica read can go again to the primary.
- **A native Redis shard (`redis-native`) replies only after its writes are stored.** Its object is a replica of the
  container's Redis and stores the replication stream; a batch's replies wait until the stream reaches the batch's
  `ROLE` offset (`server/box/proxy.ts`, `mux.ts`). A generation becomes current only once it holds everything the one
  before does, and a container that never finished its restore is destroyed, never synced from (`packages/box/README.md`).
- **A replica serves only while its stream lasts.** When a primary stops streaming to a replica it calls
  `retire()`, and the replica resets, so it never serves data that has stopped updating and routers' open sockets to
  it close. A close from the primary's end doesn't reach the replica, so never rely on it. (A primary that resets
  can't call it; its next copy stops reads instead.) Replicas run with `import-mode` and no memory limit, and the
  stream is the import source: only the primary decides which keys expire or go.
- **A replica copy sees files that only grow.** No AOF rewrite may start while a copy runs (`Replicator.copying`), a
  copy waits for a rewrite that is running (`host.rewriting`), and a copy refuses an RDB base: it needs commands.
  Replica copies must never overlap a rewrite.
- **A rewrite's base is exactly the files before its incr file.** The shard sends its rewriter the files from before
  the incr file Valkey opened for the rewrite; the rewriter runs with `import-mode` (no expiry or eviction); the
  shard installs a base only if its length and FNV-1a checksum match. `rk_rewrite_done` gets back the generation
  Valkey passed to `aof_rewrite`, so a stale finish is ignored. Until then, the old manifest and the new incr file
  hold everything.
- **VFS keys are never reused.** A file's chunks live under its key (`vfs_node.chunks`; NULL means its path, for
  files from before keys), and every new file gets a fresh key, so a rename moves one row. The chunk rows of a
  deleted file stay in `vfs_chunk`, with the key in `vfs_trash`, until the host's sweep removes them. Chunk keys are
  a one-way change: code from before them can't read files written since.
- **A dropped database stays dropped.** Its catalog row keeps `dropped`, so the name and its shards' names are never
  reused, and each of its shards keeps a `dropped` table and never boots Valkey. The tombstone is stored before
  anything is deleted. Keep that check (`isDropped`) first in the `ValkeyShard` constructor, and make every new entry
  point refuse a dropped shard (`#live()`).
- **An object's name says what it runs.** A Redis database's objects have a `redis` segment in their names
  (`shardName` in `server/catalog/placement.ts`) and `flavourOf` reads it; a database's flavour never changes. Any
  new object a database uses must be named from its shard's name, or from `shardName`, so it boots the same
  server. Both wasm builds must keep the host interface (`interface.txt`) the host provides; a server-specific
  flag goes in that server's patches, not in a branch in the TypeScript.
- **A restart marker means nothing unanswered ran.** A shard that restarts onto newer code sends a router socket
  its greeting again only after `drain()`: no input read after it, everything Valkey read answered, every write
  committed. The router resends what is pending only on that marker, or when a socket closes before its greeting
  (the output gate held anything the shard did there). Keep both; a reset that isn't clean must still give `LOST`.
  Keep the dial addresses too (`router-<ms>`, `repl-<ms>`, and the old `router`, `repl`; `deployedAt` and
  `dialedFrom` in `server/shard/version.ts`): old and new code dial each other during a deploy.
- **Idle replication sleeps.** A primary retires its replicas after `REPL_IDLE_MS` with no client activity, so every
  new client entry point on `ValkeyShard` must count as activity (`#active()`), or the database can sleep under
  traffic that only reaches the new path. Retired replicas never serve reads.
- **Replicas never share a class with a primary.** Shard class `k` keeps its replicas in `SHARD{8 + k}`
  (`replicaBinding` in `server/replication/names.ts`); routers and primaries both use it.
- **Every buffer is bounded.** Each queue has a high and low mark in its directory's `config.ts`, and stops reading
  its source at the high mark. Client input is bounded by `MAX_REQUEST`, or `MAX_UNAUTHED` before AUTH. Replication
  bytes go through `hold`/`release` on the host, so they count toward `SHARD_HIGH_WATER`, and a replica past
  `REPL_BACKLOG` is dropped. No unbounded queue, however unlikely its growth looks.
- **A failure says what it knows.** When a shard resets mid-command, the client gets `LOST` ("may or may not have
  run"), never a guess. Only read-only commands retry. A WATCH lost to a reset makes EXEC abort. If Valkey throws
  mid-command, the shard resets (the `fatal` option `bootShard` gives `ValkeyHost`) rather than run on with memory it
  can't trust.
- **One server, as clients see it.** Commands the router answers itself (connection state, fan-out, AUTH) are
  refused inside MULTI (`NOT_IN_MULTI` in `server/router/command-sets.ts`), since queued they would reach one
  shard's connection, which may be a pooled one. A new command the router handles itself goes in that set too. A
  transaction always runs on a socket.
- **Clients can't tell the router from Valkey.** Errors and replies the router writes itself match Valkey
  byte-for-byte (`server/router/replies-text.ts`; `test/differential.mjs` compares 1 shard against N shards). Copy
  Valkey's wording from its source.

## Handling input

- **Parse untrusted input once, where it enters.** Client bytes go through `request()` in
  `server/protocol/request.ts` with a size limit. Database names have one rule, `DB_NAME` in
  `server/catalog/names.ts`, checked at AUTH and again by the catalog and `Admin`. They can't contain dots, which
  keeps them from forming a replica name (`<shard>.r.<region>`). Region lists are checked against `HINTS` by the
  catalog. Environment config is parsed and validated where it is read (`parseEpochs` in `server/catalog/epochs.ts`),
  and a bad value throws instead of falling back. Other runtime input (attachments, server function inputs) is
  checked with valibot.
- **Compare secrets in constant time** (`sameSecret`). A database's own password is stored only as a salted hash
  (`hashSecret`, both in `server/router/secrets.ts`), and AUTH checks the shared password before it looks up or
  creates a database.
- **Clients don't change the service's settings.** `CONFIG SET` takes only the settings in `CONFIG_SET`
  (`server/router/command-sets.ts`), which change how data behaves. Never add one for durability, memory, networking
  or auth. SAVE, BGREWRITEAOF and ACL stay unsupported.

## Layout

| Path | What |
| --- | --- |
| `wrangler.jsonc` | The Worker's config, at the root because the Deploy to Cloudflare button reads it there. `main` is `apps/dashboard/src/server.ts`; `npm run deploy` builds the dashboard and deploys `apps/dashboard/dist/server/wrangler.json` |
| `apps/dashboard/` | The dashboard (TanStack Start, React, `@cloudflare/kumo`) and the Worker's entry, `src/server.ts`: `worker()` from `@vado/server`, the dashboard loaded on the first page request, and every Durable Object class exported by name. `src/server/` holds the server functions that call `Admin`; `src/lib/live.ts` reads `/live` |
| `apps/docs/` | The documentation site: TanStack Start, its own Worker (`vado-docs`), pages in `src/content/` |
| `server/index.ts` | The database's side of the Worker: `connect()`, `/ws`, `/live`, the bench API, and the `Admin` export |
| `server/migrate.ts` | Applies an object's `DurableMigrations` list ([SQL](#sql)) |
| `server/isolate-cache.ts` | `IsolateCache`: values fetched once per isolate ([isolate cache](#isolate-cache)) |
| `server/env.d.ts` | Optional settings a deploy may add on top of the generated bindings |
| `server/router/` | `router.ts`: one `Router` per connection: parses each request (with its size limit) and hands it to the handlers below. `serve.ts`: a connection to a Router. `routing.ts`: a request to one shard's upstream, and replica reads with their fallback to the primary. `replies.ts`: `ReplyQueue`, replies in request order. `read-your-writes.ts`: `ReadYourWrites`. `socket-upstream.ts`, `rpc-upstream.ts`, `pool.ts`: upstreams over a socket or RPC batches, and the per-isolate socket budget. `fanout.ts`, `split.ts`, `rpc-commands.ts`: commands that go to every shard, multi-key commands split by shard, and SCAN, RANDOMKEY, WAIT. `transaction.ts`, `session.ts`, `pubsub.ts`, `auth.ts`, `sign-ins.ts`. `command-sets.ts`, `command-table.ts`, `replies-text.ts`: command sets, key positions per command, and the replies the router writes itself. `pulse-report.ts`, `websocket.ts`, `secrets.ts` |
| `server/protocol/` | `request.ts` (the client request parser), `resp.ts` (frame ends, encoding), `decode.ts` (whole replies), `resp-client.ts` (a small RESP client for the bench, `Admin` and the Watcher), `slots.ts` (hash slots), `commands.ts` (key positions from Valkey's COMMAND) |
| `server/shard/` | `shard.ts`: `ValkeyShard` (thin: refuses a dropped shard, delegates the rest). `classes.ts`: `ValkeyShard1` to `ValkeyShard15` (0-7 primaries, 8-15 read replicas). `boot.ts`: schema, Valkey, and the role. `primary.ts`: a primary's alarms and replication. `replica.ts`, `rewrites.ts` (when to rewrite), `upgrade.ts` (restarts onto newer code), `tombstone.ts`, `reset.ts`, `stats.ts`, `probes.ts`, `valkey-args.ts`, `servers.ts`, `version.ts` |
| `server/shard/host/` | `valkey-host.ts`: `ValkeyHost`, runs valkey.wasm. `loop.ts` (event loop, group commit, `rk_tick`), `sockets.ts` (client fds and the byte budget), `serve.ts`, `internal.ts` (pooled clients for RPC batches), `aof-rewrite.ts` (the `aof_rewrite` import), `wasi.ts`, `gauge.ts` |
| `server/shard/vfs/` | `vfs.ts`: `Vfs`, WASI files on SQLite. `store.ts`, `chunks.ts`, `statements.ts`, `listing.ts` (rows and queries), `wasi-*.ts` (the preview1 calls), `memory.ts` |
| `server/shard/rewriter/` | `rewriter.ts`: `ValkeyRewriter`. `classes.ts`: `ValkeyRewriter1` to `ValkeyRewriter7`. `client.ts`: `rewriteByHelper`, the shard's side. `protocol.ts`: the socket protocol |
| `server/replication/` | `replicator.ts`: `Replicator` (copies, streams to and measures a primary's replicas). `link.ts`: one replica's socket and queue. `wire.ts`: the bytes on that socket. `names.ts`: replica names, bindings, dial addresses. `aof-files.ts`. `regions.ts`: location hints, region names, colo to region, `coloOf`. `colos.json`: colo city and coordinates (generated by `packages/server/scripts/colos.mjs`) |
| `server/catalog/` | `catalog.ts`: `Catalog` (databases: shard count, `regions`, `replicas`, `classes`, `secret`, `dropped`, `flavour`). `databases.ts`: the per-isolate record cache. `placement.ts`: shard and replica stubs, names, which replica a router reads (`NEAR`). `epochs.ts`: `SHARD_EPOCHS`. `names.ts`: `DB_NAME` |
| `server/admin/` | `admin.ts`: `Admin`, what the dashboard does besides watching. `watcher/`: `Watcher`, one per watched database, behind `/live`, with its probes, events, state and test traffic. `pulse.ts`: `Pulse`. `snapshot.ts`, `views.ts`: shards and replicas in plain numbers. `access.ts`: who may change things. `command.ts`. `live-types.ts`: what `/live` and `Admin` return, types only, so the browser imports them |
| `packages/server/test/`, `apps/dashboard/test/` | Unit tests, at the same paths as the `src/` files they test. `test/shard/vfs/fake-storage.ts` is SQL storage over `node:sqlite` |
| `server/box/` | The `redis-native` flavour: `box.ts`: `RedisBox`, a shard whose server runs in a container. `engine.ts` (the running container, compaction, idle stop), `redis.ts` (start and restore), `link.ts` (the replica link into storage), `proxy.ts`, `mux.ts` (client connections, fenced), `store.ts`. Built only with `VADO_CONTAINERS=1`; the image is `packages/box/redis/Dockerfile` |
| `server/bench/` | `bench.ts`: the token-protected bench API and its `tests` map. `catalog-tests.ts`, `shard-probes.ts`, `data-tests.ts`, `load-tests.ts`: the tests. `sender.ts`: `Sender`, runs a test from a chosen region, and the dashboard's test traffic |
| `packages/client/` | `src/ioredis.ts`: `bindingConnector`, ioredis over a service binding. `ws-shim.mjs`: a local TCP port for `/ws` (`node packages/client/ws-shim.mjs <url> <port>`, Node 22+). Neither is published to npm |
| `packages/wasm/` | The builds: `valkey/` and `redis/` (each with `build.sh`, `patches/`, the committed wasm and `interface.txt`), the shared `wasi/`, `common.sh` and `interface.mjs`. CI rebuilds both from the official releases (`.github/workflows/wasm.yml`) |
| `test/` | End-to-end tests against a running Worker; `test/e2e.sh` runs them all |

## Code rules

- TypeScript, `strict`. No lint suppressions; fix what the linter finds.
- At most 250 lines a file (`max-lines`, enforced by lint). Split by responsibility, as the directories above do.
- Each directory keeps its types in `types.ts` and its tunables in `config.ts`.
- Validate runtime input with valibot.
- Few comments: only a why the code can't show.

## Structure

- Each tunable in a `config.ts` has a comment saying why it has its value. Protocol constants stay in the module that
  speaks the protocol.
- Durable Object methods are RPC: routers running older code call them during a deploy, so keep names and signatures
  stable and make changes additive. That covers `ValkeyShard` (including `replicate`, `replicaReady`, `snapshot`,
  `commitProbe`), `Catalog`, `Pulse` (`report`, `snapshot`), `Sender` (`run`, `loop`, `stop`), `Watcher` (`note`,
  `restarting`, `startTest`, `stopTest`) and the rewriter's `deployedAt`. The same goes for the rewriter's socket
  protocol (a JSON line, the files, then the base back), since old shards send rewrites to new rewriters. Use
  `#private` members so helpers aren't exposed over RPC.
- Keep Durable Object classes thin. `ValkeyShard` refuses a dropped shard and delegates to what `bootShard` builds:
  `ValkeyHost` (`server/shard/host/valkey-host.ts`), `Vfs` (`server/shard/vfs/vfs.ts`), `PrimaryRole`
  (`server/shard/primary.ts`, with `Replicator` and `Rewrites`), `ReplicaRole` and `Upgrader`.
- A database's shard count, regions, replicas and classes are fixed when it is created. Change capacity for new
  databases by appending to `SHARD_EPOCHS`, never by editing an existing epoch.
- New Durable Object classes need a migration tag in `wrangler.jsonc`, and a named export in
  `apps/dashboard/src/server.ts` (wrangler reads those names to type the bindings).
- Keep shard classes and rewriter classes in step: `ValkeyShard<k>` (binding `SHARD<k>`) finds `ValkeyRewriter<k>`
  (`REWRITER<k>`) by binding name (`REWRITERS` in `server/shard/boot.ts`). Adding classes means bindings and a
  migration for both. Never remove a shard class: a database keeps shard `i` in class `i % classes`, as recorded in
  the catalog.
- Changes to a server go in `packages/wasm/<server>/patches/` or `packages/wasm/wasi/`, with its wasm rebuilt by its
  `build.sh` and its `interface.txt` regenerated. CI fails unless the committed wasm is exactly what the build
  produces.
- The dashboard only renders. Numbers, rates and events come from the Watcher; rules live in `Admin`. Shared
  constants and types (regions, colos, slots, `live-types.ts`) are imported from `@vado/server`, not copied.

## SQL

- Each object's tables are drizzle `sqliteTable` definitions in its directory's `schema.ts`
  (`server/catalog/schema.ts`, `server/shard/schema.ts`, `server/shard/vfs/schema.ts`,
  `server/replication/schema.ts`). Queries go through drizzle (`drizzle-orm/durable-sqlite`).
- The tables themselves come from `DurableMigrations` lists in `migrations.ts` next to each schema. `migrate()` in
  `server/migrate.ts` applies the ones an object hasn't run, in one transaction, with workers-qb's `DOQB`, recorded
  in `durability_migrations`. A schema change is a new migration appended to the list; never edit one that shipped.
- Objects from before migrations already have their tables, which a migration's `CREATE TABLE IF NOT EXISTS` skips.
  `legacy.ts` (`server/catalog/legacy.ts`, `server/shard/vfs/legacy.ts`) adds the columns those old tables lack
  before the migrations run.
- Table and column names never change: old code reads the same storage during a deploy and after a rollback.

## Scheduled work

Each object has one physical alarm. Named alarms from durability's `DurabilityAlarms` share it, and `alarm()` only
delegates (`this.#alarms.alarm(info)`, or the shard's `DurabilityScheduler`). Lint (`durability/alarm-runner-only`
and friends) keeps it that way.

- A primary shard (`server/shard/primary.ts`): `rewriteCheck` (the AOF size check, `AOF_CHECK_MS` after an append),
  `replicaTick` (every `REPL_TICK_MS` while replicas are configured and awake; it also runs the AOF check) and
  `upgrade` (the retry of a restart onto newer code).
- The Watcher: `poll`, every `WATCH_MS` while anyone watches. Each poll schedules the next.
- A Sender: `round`, one round of test traffic at a time, and `deadline`, which stops it.

## /live

`/live?db=<name>` is a `DurabilitySocket` on that database's `Watcher` (`server/admin/watcher/watcher.ts`). Inbound,
the page asks for a `snapshot` (history, events, state); outbound, the Watcher sends a `tick` per poll, and keeps
`WATCH_REPLAY` of them for a page that reconnects. The page's side is `DurabilitySocketClient` from
`durability/client`, in `apps/dashboard/src/lib/live.ts`. The Worker sets whether the viewer may change things, kept as socket metadata.
Keep `/live` read-only, and never send keys, values or client addresses on it.

## Isolate cache

`IsolateCache` (`server/isolate-cache.ts`) holds values every connection in an isolate shares: database records,
the command table. Each client connection is its own request, and a promise settles only in the request that made
it, so a plain cached promise can hang another connection, or fail when its connection ends first. The cache shares a
fetch while it lasts, lets a waiter fetch for itself if that fails, and keeps settled values so later connections
never wait on another request. Use it for any new per-isolate value; never cache a bare promise in module scope.

## Types

- `worker-configuration.d.ts` is generated: `npx wrangler types --strict-vars=false`, with a `.dev.vars` present so
  `VALKEY_PASSWORD` is typed. Regenerate it after any change to `wrangler.jsonc`, and never edit it by hand.
- `server/env.d.ts` adds the optional settings a deploy may set (`BENCH_TOKEN`, `LOCATION_HINT`, `SHARD_EPOCHS`,
  `ROUTER_*`, `VALKEY_*`) to `Env`.

## Bench endpoints

Tests are the `tests` map in `server/bench/bench.ts`; [operations](https://vado-docs.vaishnav.one/docs/operations#bench)
lists them. `send?region=<hint>&sender=<k>` runs any test from a Sender object in that region.

## The dashboard

The dashboard is `apps/dashboard`, in the same Worker, deployed with it (`npm run deploy`). Its server functions
(`apps/dashboard/src/server/admin.ts`) check the shape of every input with valibot and call `Admin` in-process.
Watching is public;
anything that changes something is checked by `apps/dashboard/src/server/access.ts` on every call.

## Commits

One change per commit, with a short lowercase imperative subject (`bound unauthenticated requests`).

## Before you finish

```sh
npm run check   # vp check (oxfmt; oxlint with anti-slop and @durability/lint, type-aware), tsrs --noEmit --fast
npm test        # vp test: unit tests in plain Node
npm run build   # vp build in apps/dashboard
```

For behaviour changes, run `test/e2e.sh` against a deployment of your own (its header lists `BASE`, `TOKEN`, `PW`
and the rest). It creates fresh databases and runs the automatic `test/*.mjs` checks plus the bench durability,
replica and drop checks. `test/deploy.mjs` is manual: run it while you deploy from another shell. Set `FLAVOUR=redis` to run it on Redis (the deploy needs `VADO_REDIS=1`).

For production checks, wait at least 5 minutes after `wrangler deploy`: earlier routers keep running the old code
until their connections end. Measure against a deployed Worker only with your own account and data.
