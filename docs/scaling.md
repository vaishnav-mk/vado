# Shards, placement and limits

## Slots and shards

A key hashes to one of 16,384 slots (CRC16, as in Valkey Cluster; a `{hashtag}` hashes only the part in braces).
Shard `i` of `n` owns a contiguous slot range, so a shard could later split without remapping its neighbors.

A database's shard count is fixed when it is created:

- by the `SHARD_EPOCHS` entry in force at its creation time: `[{ "from": <ms>, "shards": <n> }]`, ordered by `from`,
  the first at 0;
- or explicitly, with the bench API's `GET /db?db=<name>&shards=<n>`.

Appending an epoch that starts later sizes new databases without moving any existing one. Never edit an existing
epoch: its databases would route to the wrong shards.

A 1-shard database has no cross-slot limits. It holds 64 MB.

## Placement

Shards are created in the `LOCATION_HINT` region, if one is set, instead of near their first caller. A shard that
exists keeps its place. The router runs wherever the client's connection lands, so latency is the client's hop to
the Worker plus the Worker's hop to the shard ([measurements](measurements.md)).

## Connections

Each client connection gets its own router, and each router opens a socket to every shard it uses. Sockets keep
per-shard order for free, but the runtime drops sockets past a few hundred per isolate. So past `SOCKET_BUDGET`
(128) open shard sockets in an isolate, new upstreams send stateless batches over RPC instead. Each shard keeps up
to 64 pooled internal clients (`POOL_MAX`) for those batches, so one doesn't cost a Valkey connection each.

Shard sockets idle for 30 s (`IDLE_MS`) close, so an idle shard stops being billed and can sleep. The client's
connection doesn't notice.

## Backpressure

Every hop stops reading its source at a high mark and resumes below a low mark (`src/constants.js`):

| Hop | High / low | Stops reading |
| --- | --- | --- |
| A router's unacknowledged bytes to its client or any shard | 1 MB / 256 KB | Its client |
| All routers' shard-bound bytes in an isolate | 32 MB / 16 MB | Every client in the isolate |
| A shard's unacknowledged replies to one client | 256 KB / 64 KB | That client |
| All of a shard's unacknowledged replies | 16 MB / 8 MB | Every client of the shard |
| WebSocket ingress | 16 MB queued | Can't push back, so it disconnects the client |

So memory stays bounded, and overload shows up as slower clients rather than errors.

## Limits

- **Memory:** 64 MB of data per shard (`VALKEY_MAXMEMORY`). With `noeviction`, writes past it get Valkey's `OOM`
  error; with `allkeys-lru` it evicts like a cache.
- **Request size:** about 8 MB per request, all arguments together, and 64 KB before AUTH. A shard needs room for the
  query buffer, the value and its AOF entry at once.
- **CPU:** a shard is one thread. The runtime resets an object kept near 100% CPU, so a single hot key has a ceiling
  that more shards don't raise. One command can use about 30 s of CPU.
- **Cold start:** a shard that was evicted while idle reloads its AOF on the next command ([measurements](measurements.md)).
- **No online resharding.** A database keeps its shard count for life.
- **Unsupported:** MONITOR, replication commands (SYNC, PSYNC, REPLICAOF, FAILOVER), SHUTDOWN, DEBUG, MIGRATE, MOVE,
  SWAPDB, BGSAVE, CLIENT TRACKING and the other connection-wide CLIENT subcommands, and SELECT above 0 (use another
  database name instead).
