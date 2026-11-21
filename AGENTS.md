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
  `READ_YOUR_WRITES_MS` after the reply. Only retryable reads (read-only, non-blocking, outside MULTI/WATCH) may go
  to a replica, so a failed replica read can go again to the primary.
- **A replica copy sees files that only grow.** No AOF rewrite may run while a copy does (`Replicator.copying`), and
  a copy needs a base made of commands, not RDB.
- **Every buffer is bounded.** Each queue has a high and low mark in `src/constants.js`, and stops reading its source
  at the high mark. Client input is bounded by `MAX_REQUEST`, or `MAX_UNAUTHED` before AUTH. Replication bytes go
  through `hold`/`release` on the host, so they count toward `SHARD_HIGH_WATER`, and a replica past `REPL_BACKLOG`
  is dropped. No unbounded queue, however unlikely its growth looks.
- **A failure says what it knows.** When a shard resets mid-command, the client gets `LOST` ("may or may not have
  run"), never a guess. Only read-only commands retry. A WATCH lost to a reset makes EXEC abort.
- **Clients can't tell the router from Valkey.** Errors and replies the router writes itself match Valkey
  byte-for-byte (`test/differential.mjs` compares 1 shard against N shards). Copy Valkey's wording from its source.

## Handling input

- **Parse untrusted input once, where it enters.** Client bytes go through `request()` in `src/resp.js` with a size
  limit. Database names have one rule, `DB_NAME` in `src/catalog.js`, checked at AUTH and again by the catalog at its
  RPC entry. They can't contain dots, which keeps them from forming a replica name (`<shard>.r.<region>`). Region
  lists are checked against `HINTS` by the catalog. Environment config is parsed and validated where it is read
  (`parseEpochs`), and a bad value throws instead of falling back.
- **Compare secrets in constant time** (`sameSecret`).

## Files

| Path | What |
| --- | --- |
| `src/index.js` | Worker entry: `connect()`, `/ws`, shard and replica stubs, placement (`regions[i % n]`), which replica a router reads (`NEAR`), Pulse reports |
| `src/router.js` | One per connection: parsing, routing, MULTI/WATCH, read-your-writes, replica fallback |
| `src/shard.js` | `ValkeyShard`: boots Valkey (primary or replica, from its name), schedules AOF rewrites |
| `src/valkey-host.js` | Runs valkey.wasm: sockets as fds (reused once closed), group commit, `rk_tick` |
| `src/vfs.js` | WASI filesystem on SQLite; `onAppend` feeds replication |
| `src/replication.js` | `Replicator`: copies, streams to and measures a primary's replicas |
| `src/catalog.js` | Databases: shard count, `regions`, `replicas` |
| `src/pulse.js` | `Pulse`: each isolate's latest connection report, in memory |
| `src/sender.js` | `Sender`: runs a bench test from a chosen region |
| `src/regions.js` | Colo to location hint, generated from https://speed.cloudflare.com/locations |
| `src/bench.js` | The token-protected bench API |
| `ui/` | The local live view: `server.mjs` (Node, holds the secrets) and a Vite + React + `@cloudflare/kumo` page |

## Structure

- Tunables live in `src/constants.js`, each with a comment saying why it has its value. Protocol constants stay in
  the module that speaks the protocol. Groups: router, shard host (including `SHARD_COMMITS`), storage, AOF
  rewrites (`AOF_REWRITE_MIN`, `AOF_REWRITE_IDLE_MS`, `AOF_REWRITE_CAP`, `AOF_CHECK_MS`), read replicas
  (`REPL_BACKLOG`, `REPL_TICK_MS`, `REPL_RETRY_MS`, `REPL_STUCK_MS`, `READ_YOUR_WRITES_MS`), live view (`PULSE_MS`)
  and WebSocket ingress.
- Durable Object methods are RPC: routers running older code call them during a deploy, so keep names and signatures
  stable and make changes additive. That covers `ValkeyShard` (including `replicate`, `replicaReady`, `snapshot`,
  `commitProbe`), `Catalog`, `Pulse` (`report`, `snapshot`) and `Sender` (`run`). Use `#private` members so helpers
  aren't exposed over RPC.
- Keep Durable Object classes thin. `ValkeyShard` boots Valkey and delegates to `ValkeyHost` (`src/valkey-host.js`),
  `Vfs` (`src/vfs.js`) and `Replicator` (`src/replication.js`).
- A database's shard count, regions and replicas are fixed when it is created. Change capacity for new databases by
  appending to `SHARD_EPOCHS`, never by editing an existing epoch. New catalog columns are added on startup when
  missing, as `regions` and `replicas` are.
- New Durable Object classes need a migration tag in `wrangler.jsonc`, and a namespace in `config.capnp.in` if local
  runs need them.
- Changes to Valkey itself go in `wasm/patches/` or `wasm/wasi/`, with `vendor/valkey.wasm` rebuilt by `wasm/build.sh`.
- Comment the why the code can't show, not the what.

## Bench endpoints

Tests are the `tests` object in `src/bench.js`; [operations](docs/operations.md#the-bench-api) lists them all. The
live view reads `shards`, `dbs` and `pulse`. `send?region=<hint>&sender=<k>` runs any test from a Sender object in
that region. `commit`, `staleness`, `ryw`, `replicate` and `rpcbatch` probe commits, replica lag, read-your-writes,
replication cost and the RPC path; `throughput` takes `keys=<m>` to reuse m keys per connection.

## The live view

```sh
npm install && npm --prefix ui install && npm --prefix ui run build
VADO_URL=https://<your-worker>.workers.dev TOKEN=<bench token> HOST=<your-host> PORT=6379 PW=<password> DB=<name> npm run ui
```

Open http://127.0.0.1:4040. The server keeps the token and password local and listens on 127.0.0.1 only; keep it
that way. Rebuild `ui/dist` after changing `ui/src`.

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
