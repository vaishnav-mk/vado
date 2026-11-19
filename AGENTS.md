# Agent guide

Rules for anyone, human or agent, changing this repo.

## Invariants

- **An acknowledged write is durable.** Valkey runs with `appendfsync always`, and the VFS writes AOF appends to SQLite
  synchronously, so the output gate holds a reply until its write is stored. Nothing may reply to a write before
  that, and nothing may buffer AOF bytes past a reply.
- **Replies leave in request order, per connection.** Socket upstreams keep per-shard order on their own. A command
  that goes by RPC (fan-out, SCAN, INFO, RPC batches) waits for every earlier reply (`#afterEarlierReplies`), and
  later requests wait for it (`#hold`). A new RPC-path command must use both.
- **Every buffer is bounded.** Each queue has a high and low mark in `src/constants.js`, and stops reading its source
  at the high mark. Client input is bounded by `MAX_REQUEST`, or `MAX_UNAUTHED` before AUTH. No unbounded queue,
  however unlikely its growth looks.
- **A failure says what it knows.** When a shard resets mid-command, the client gets `LOST` ("may or may not have
  run"), never a guess. Only read-only commands retry. A WATCH lost to a reset makes EXEC abort.
- **Clients can't tell the router from Valkey.** Errors and replies the router writes itself match Valkey
  byte-for-byte (`test/differential.mjs` compares 1 shard against N shards). Copy Valkey's wording from its source.

## Handling input

- **Parse untrusted input once, where it enters.** Client bytes go through `request()` in `src/resp.js` with a size
  limit. Database names have one rule, `DB_NAME` in `src/catalog.js`, checked at AUTH and again by the catalog at its RPC entry. Environment config is parsed and
  validated where it is read (`parseEpochs`), and a bad value throws instead of falling back.
- **Compare secrets in constant time** (`sameSecret`).

## Structure

- Tunables live in `src/constants.js`, each with a comment saying why it has its value. Protocol constants stay in
  the module that speaks the protocol.
- Durable Object methods are RPC: routers running older code call them during a deploy, so keep names and signatures
  stable and make changes additive. Use `#private` members so helpers aren't exposed over RPC.
- Keep Durable Object classes thin. `ValkeyShard` boots Valkey and delegates to `ValkeyHost` (`src/valkey-host.js`)
  and `Vfs` (`src/vfs.js`).
- A database's shard count is fixed when it is created. Change capacity for new databases by appending to
  `SHARD_EPOCHS`, never by editing an existing epoch.
- Changes to Valkey itself go in `vendor/valkey-wasm.patch`, with `vendor/valkey.wasm` rebuilt from it.
- Comment the why the code can't show, not the what.

## Commits

One change per commit, with a short lowercase imperative subject (`bound unauthenticated requests`).

## Before you finish

```sh
scripts/test-local.sh
```

For production checks, wait at least 5 minutes after `wrangler deploy`: earlier routers keep running the old code
until their connections end. Measure against a deployed Worker only with your own account and data.
