# Agent guide

Rules for anyone, human or agent, changing this repo.

## Invariants

- **An acknowledged write is durable.** Valkey runs with `appendfsync always`, and the VFS writes AOF appends to SQLite
  synchronously, so the output gate holds a reply until its write is stored. Nothing may reply to a write before
  that, and nothing may buffer AOF bytes past a reply. Group commit (`SHARD_COMMITS`) may delay input, never a commit.
- **Replies leave in request order, per connection.** Socket upstreams keep per-shard order on their own. A command
  that goes by RPC (fan-out, SCAN, INFO, RPC batches) waits for every earlier reply (`#afterEarlierReplies`), and
  later requests wait for it (`#hold`). A new RPC-path command must use both.
- **Replicas get only committed writes, and a connection reads its own writes.** The replication stream
  (`Vfs.onAppend`) leaves through the primary's output gate; never send it any other way. A router path that writes
  must bracket the send with `#writeStart`/`#writeDone`, so that connection reads the shard from its primary until
  `READ_YOUR_WRITES_MS` after the reply; a fan-out that writes counts for every shard (`#wroteAll`). Only
  retryable reads (read-only, non-blocking, outside MULTI/WATCH) may go to a replica, so a failed replica read can
  go again to the primary.
- **A replica serves only while its stream lasts.** When the primary closes its stream, the replica resets, so it
  never serves data that has stopped updating and routers' open sockets to it close. (A primary that resets may not
  close it; its next copy stops reads instead.) Replicas run with
  `import-mode` and no memory limit, and the stream is the import source: only the primary decides which keys
  expire or go.
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
  anything is deleted. Keep that check first in the `ValkeyShard` constructor, and make every new entry point
  refuse a dropped shard (`#live()`).
- **Idle replication sleeps.** A primary retires its replicas after `REPL_IDLE_MS` with no client activity, so every
  new client entry point on `ValkeyShard` must count as activity (`#active()`), or the database can sleep under
  traffic that only reaches the new path. Retired replicas never serve reads.
- **Replicas never share a class with a primary.** Shard class `k` keeps its replicas in `SHARD{8 + k}`
  (`replicaBinding`); routers and primaries both use it.
- **Every buffer is bounded.** Each queue has a high and low mark in `src/constants.js`, and stops reading its source
  at the high mark. Client input is bounded by `MAX_REQUEST`, or `MAX_UNAUTHED` before AUTH. Replication bytes go
  through `hold`/`release` on the host, so they count toward `SHARD_HIGH_WATER`, and a replica past `REPL_BACKLOG`
  is dropped. No unbounded queue, however unlikely its growth looks.
- **A failure says what it knows.** When a shard resets mid-command, the client gets `LOST` ("may or may not have
  run"), never a guess. Only read-only commands retry. A WATCH lost to a reset makes EXEC abort. If Valkey throws
  mid-command, the shard resets (`fatal` on `ValkeyHost`) rather than run on with memory it can't trust.
- **One server, as clients see it.** Commands the router answers itself (connection state, fan-out, AUTH) are
  refused inside MULTI (`NOT_IN_MULTI`), since queued they would reach one shard's connection, which may be a pooled
  one. A new command the router handles itself goes in that set too. A transaction always runs on a socket.
- **Clients can't tell the router from Valkey.** Errors and replies the router writes itself match Valkey
  byte-for-byte (`test/differential.mjs` compares 1 shard against N shards). Copy Valkey's wording from its source.

## Handling input

- **Parse untrusted input once, where it enters.** Client bytes go through `request()` in `src/protocol/resp.js` with a size
  limit. Database names have one rule, `DB_NAME` in `src/catalog/catalog.js`, checked at AUTH and again by the catalog at its
  RPC entry. They can't contain dots, which keeps them from forming a replica name (`<shard>.r.<region>`). Region
  lists are checked against `HINTS` by the catalog. Environment config is parsed and validated where it is read
  (`parseEpochs`), and a bad value throws instead of falling back.
- **Compare secrets in constant time** (`sameSecret`). A database's own password is stored only as a salted hash
  (`hashSecret`), and AUTH checks the shared password before it looks up or creates a database.
- **Clients don't change the service's settings.** `CONFIG SET` takes only the settings in `CONFIG_SET`
  (`src/router/router.js`), which change how data behaves. Never add one for durability, memory, networking or auth.
  SAVE, BGREWRITEAOF and ACL stay unsupported.

## Files

| Path | What |
| --- | --- |
| `src/index.js` | Worker entry: `connect()`, `/ws`, `/live`, the bench API, the dashboard (`DASHBOARD`), and the Durable Object and `Admin` exports |
| `src/router/` | `router.js`: one per connection: parsing, routing, MULTI/WATCH, read-your-writes, replica fallback. `serve.js`: a connection to a Router, the command table, Pulse reports. `websocket.js`, `secrets.js` |
| `src/protocol/` | `resp.js` (RESP frames, decoding, encoding), `slots.js` (hash slots, shard epochs), `commands.js` (key positions from Valkey's COMMAND) |
| `src/shard/` | `shard.js`: `ValkeyShard` to `ValkeyShard15` (0-7 primaries, 8-15 read replicas): boots Valkey, schedules AOF rewrites. `valkey-host.js`: runs valkey.wasm (sockets as fds, group commit, `rk_tick`, the `aof_rewrite` import, the delete sweep). `vfs.js`: WASI files on SQLite. `rewriter.js`: `ValkeyRewriter` to `ValkeyRewriter7` |
| `src/replication/` | `replication.js`: `Replicator` (copies, streams to and measures a primary's replicas). `regions.js`: location hints, region names, colo to region, `coloOf`. `colos.js`: colo city and coordinates (generated by `scripts/colos.mjs`) |
| `src/catalog/` | `catalog.js`: `Catalog` (databases: shard count, `regions`, `replicas`, `classes`, `secret`, `dropped`). `databases.js`: the per-isolate record cache, shard and replica stubs, shard classes, which replica a router reads (`NEAR`) |
| `src/admin/` | `admin.js`: the `Admin` RPC entrypoint the dashboard calls. `watcher.js`: `Watcher`, one per watched database, behind `/live`. `snapshot.js` and `views.js`: shards and replicas in plain numbers. `pulse.js`: `Pulse` |
| `src/bench/` | `bench.js`: the token-protected bench API. `sender.js`: `Sender`, runs a test from a chosen region, and the dashboard's test traffic |
| `src/client/` | `resp-client.js`: a small RESP client (bench, Admin, Watcher). `ioredis.js`: `bindingConnector`, ioredis over a service binding |
| `dashboard/` | The dashboard Worker `vado-dashboard`: TanStack Start, React, `@cloudflare/kumo`. Renders `/live` and calls `Admin`; no logic of its own |
| `wasm/` | The Valkey build: `build.sh`, `patches/`, `wasi/`, the committed `valkey.wasm` and `interface.txt`. CI rebuilds it from the official release (`.github/workflows/wasm.yml`) |

## Structure

- Tunables live in `src/constants.js`, each with a comment saying why it has its value. Protocol constants stay in
  the module that speaks the protocol. Groups: router, shard host (including `SHARD_COMMITS`, `SHARD_CLASSES`),
  storage (including `VFS_SWEEP_BYTES`, `VFS_SWEEP_MS`), AOF rewrites (`AOF_REWRITE_MIN`, `AOF_REWRITE_IDLE_MS`,
  `AOF_REWRITE_CAP`, `AOF_CHECK_MS`, `AOF_HELPER_TIMEOUT_MS`, `AOF_HELPER_RETRY_MS`), read replicas
  (`REPL_BACKLOG`, `REPL_TICK_MS`, `REPL_RETRY_MS`, `REPL_STUCK_MS`, `READ_YOUR_WRITES_MS`), live view (`PULSE_MS`),
  WebSocket ingress, and the dashboard (`WATCH_MS`, `WATCH_HISTORY`, `WATCH_RATE_POLLS`, `TEST_TRAFFIC_MS`).
- Durable Object methods are RPC: routers running older code call them during a deploy, so keep names and signatures
  stable and make changes additive. That covers `ValkeyShard` (including `replicate`, `replicaReady`, `snapshot`,
  `commitProbe`), `Catalog`, `Pulse` (`report`, `snapshot`), `Sender` (`run`, `loop`, `stop`), `Watcher` (`note`,
  `restarting`, `startTest`, `stopTest`), and the `Admin` entrypoint the dashboard Worker calls (it deploys
  separately, so it may run older or newer code than this Worker). The same goes for the rewriter's
  socket protocol (a JSON line, the files, then the base back), since old shards send rewrites to new rewriters.
  Use `#private` members so helpers aren't exposed over RPC.
- Keep Durable Object classes thin. `ValkeyShard` boots Valkey and delegates to `ValkeyHost` (`src/shard/valkey-host.js`),
  `Vfs` (`src/shard/vfs.js`), `Replicator` (`src/replication/replication.js`) and `rewriteByHelper` (`src/shard/rewriter.js`).
- A database's shard count, regions, replicas and classes are fixed when it is created. Change capacity for new
  databases by appending to `SHARD_EPOCHS`, never by editing an existing epoch. New catalog columns are added on
  startup when missing, as `regions`, `replicas` and `classes` are.
- New Durable Object classes need a migration tag in `wrangler.jsonc`, and a namespace in `config.capnp.in` if local
  runs need them.
- Keep shard classes and rewriter classes in step: `ValkeyShard<k>` (binding `SHARD<k>`) finds `ValkeyRewriter<k>`
  (`REWRITER<k>`) by binding name. Adding classes means bindings and a migration for both. Never remove a shard
  class: a database keeps shard `i` in class `i % classes`, as recorded in the catalog.
- Changes to Valkey itself go in `wasm/patches/` or `wasm/wasi/`, with `wasm/valkey.wasm` rebuilt by `wasm/build.sh`
  and `wasm/interface.txt` regenerated. CI fails unless the committed wasm is exactly what the build produces.
- The dashboard only renders. Numbers, rates and events come from the Watcher; rules and validation live in `Admin`.
  Shared constants (regions, colos, slots) are imported from `src/`, not copied.
- Comment the why the code can't show, not the what.

## Bench endpoints

Tests are the `tests` object in `src/bench/bench.js`; [operations](docs/operations.md#the-bench-api) lists them all. `send?region=<hint>&sender=<k>` runs any test from a Sender object in
that region. `commit`, `staleness`, `ryw`, `replicate` and `rpcbatch` probe commits, replica lag, read-your-writes,
replication cost and the RPC path; `frag`, `rewrite` and `vfs` probe memory against `used_memory`, a rewrite's cost
to the shard, and storage commit times for writes and deletes. `throughput` takes `keys=<m>` to reuse m keys per
connection.

## The dashboard

`dashboard/` deploys on its own (`npm --prefix dashboard run deploy`) and is reached through this Worker's URL.
Watching is public; anything that changes something needs a signed-in session, checked by `Admin` on every call.
Keep `/live` read-only, and never send keys, values or client addresses on it.

## Commits

One change per commit, with a short lowercase imperative subject (`bound unauthenticated requests`).

## Before you finish

```sh
scripts/test-local.sh
```

The local suite doesn't cover replicas or Senders (local workerd has no `SENDER` binding). For changes to either,
check a deployment with `staleness` and `ryw`, sent from several regions with `send`.

For production checks, wait at least 5 minutes after `wrangler deploy`: earlier routers keep running the old code
until their connections end. Measure against a deployed Worker only with your own account and data.
