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

Where a database's shards go is fixed when it is created, like its shard count:

- With a `regions` list (`GET /db?db=<name>&regions=weur,enam`, or `regions=world`), shard `i` is created with
  the location hint `regions[i % n]`. `world` means one shard per region in turn over `wnam`, `enam`, `sam`,
  `weur`, `eeur`, `me`, `afr`, `apac` and `oc`. The pub/sub shard stays at `LOCATION_HINT`.
- Without one, shards are created in the `LOCATION_HINT` region, if one is set, instead of near their first caller.

A location hint applies when an object is created; a shard that exists keeps its place. The router runs wherever
the client's connection lands, so latency is the client's hop to the Worker plus the Worker's hop to the shard,
plus one storage commit for a write ([measurements](measurements.md)).

### Read replicas

With a `replicas` list (`GET /db?db=<name>&replicas=world`, or `replicas=apac,weur`), every data shard keeps a read
replica in each listed region, named `<shard>.r.<region>`. Creating the database through `/db` also tells each
primary to start them, and each primary remembers its replica regions in its own storage. Writes always go to the
primary.

A router picks a replica by where it runs. It learns its location once per isolate, maps it to one of the nine
`world` regions (`src/regions.js`), and reads from the replica in that region, including the primary's own region.
Without one there, it tries the neighbours in `NEAR` (`src/index.js`):

| Router in | Then tries |
| --- | --- |
| `wnam` | `enam` |
| `enam` | `wnam` |
| `sam` | `enam`, `wnam` |
| `weur` | `eeur` |
| `eeur` | `weur` |
| `me` | `eeur`, `weur` |
| `afr` | `weur`, `eeur` |
| `apac` | `oc` |
| `oc` | `apac` |

With no match, or before the router knows its location, reads go to the primary. No router maps to `apac-ne` or
`apac-se`, so replicas there are kept current but never read. When a read goes to a replica, and what it can see:
[life of a command](lifecycle.md#reads-on-a-database-with-replicas) and
[durability](durability.md#what-a-read-from-a-replica-can-see).

## Shard classes and isolates

Objects of one Durable Object class on one machine can share an isolate, and with it the isolate's memory limit
and its one thread. Objects of different classes never do. So the shard object is exported as eight classes,
`ValkeyShard` and `ValkeyShard1` to `ValkeyShard7` (`SHARD_CLASSES`, bindings `SHARD` to `SHARD7`), and shard `i` of
a database uses class `i % 8`:

- A database's shards 0 to 7 never share an isolate with each other. Shards `i` and `i + 8` can, and so can shards
  of different databases in the same class.
- A replica uses its primary's class. The pub/sub and `__meta` shards stay in `ValkeyShard`.
- The class count is fixed when a database is created, in the catalog's `classes` column. Databases created before
  classes existed have none recorded, and keep every shard in `ValkeyShard`. The bench API's `/db` takes
  `classes=<1..8>` for experiments.

A 16-shard database in one region and one class ran in 14 isolates, one of them holding 3 shards. With 8 classes,
16 shards in one region ran in 16 isolates, and a 4-shard database with 36 replicas ran its 40 objects in 40
isolates. Each shard's stats report `isolate`, an id per isolate, so bench `stats` shows which shards share one.

## Connections

Each client connection gets its own router, and each router opens a socket to every shard it uses, and to every
replica it reads from. Sockets keep per-shard order for free, but the runtime drops sockets past a few hundred per
isolate. So past `SOCKET_BUDGET` (128) open shard and replica sockets in an isolate, new upstreams send stateless
batches over RPC instead, one RPC per batch per connection. Each shard keeps up to 64 pooled internal clients
(`POOL_MAX`) for those batches, so one doesn't cost a Valkey connection each. Many connections times many shards
end up on RPC batches, which are slower: 200 connections over 16 shards measured about 20-26k ops/s.

Shard sockets idle for 30 s (`IDLE_MS`) close, so an idle shard stops being billed and can sleep. The client's
connection doesn't notice. A primary with replicas doesn't go idle: it measures its replicas every 2 s
(`REPL_TICK_MS`) and keeps a socket open to each.

## Backpressure

Every hop stops reading its source at a high mark and resumes below a low mark (`src/constants.js`):

| Hop | High / low | Stops reading |
| --- | --- | --- |
| A router's unacknowledged bytes to its client or any shard | 1 MB / 256 KB | Its client |
| All routers' shard-bound bytes in an isolate | 32 MB / 16 MB | Every client in the isolate |
| A shard's unacknowledged replies to one client | 256 KB / 64 KB | That client |
| All of a shard's unacknowledged replies and replication bytes | 16 MB / 8 MB | Every client of the shard |
| A primary's bytes not yet sent to, or acknowledged by, one replica | 8 MB (`REPL_BACKLOG`) | Nothing: the replica is dropped and copied again |
| WebSocket ingress | 16 MB queued | Can't push back, so it disconnects the client |

So memory stays bounded, and overload shows up as slower clients rather than errors. Replicas that all lag slow
the primary's writes down; one stuck replica is dropped before it can stall them.

## Limits

- **Memory:** 64 MB of data per shard (`VALKEY_MAXMEMORY`). With `noeviction`, writes past it get Valkey's `OOM`
  error; with `allkeys-lru` it evicts like a cache. A replica holds the same data in its own 64 MB. That limit
  counts Valkey's `used_memory`; the isolate counts wasm linear memory, which measured 1.08-1.29x `used_memory`
  with the vendored build's allocator and never shrinks: after deleting data from 39 MB to 9 MB, it stayed at 44 MB
  ([measurements](measurements.md)).
- **Request size:** about 8 MB per request, all arguments together, and 64 KB before AUTH. A shard needs room for the
  query buffer, the value and its AOF entry at once.
- **CPU:** a shard is one thread, shared with any object of its class in the same isolate. The runtime resets an
  object kept near 100% CPU, so a single hot key has a ceiling that more shards don't raise. One command can use
  about 30 s of CPU.
- **Writes per shard:** measured at 114-130k SET/s with deep pipelines straight to one shard. Each replica's stream
  costs the primary: with 9 replicas, one shard took 49-61k SET/s.
- **AOF rewrites:** a rewriter object compacts the AOF while the shard keeps serving. For a 35.6 MB RDB base that
  took 5.2-5.9 s, with PINGs to the shard at p99 128-175 ms meanwhile. Each rewrite sends the base and incr files to
  the rewriter and the new base back, and the rewriter stores its copy in its own SQLite until it is done. After a
  rewriter fails, the shard rewrites inline for 10 minutes, which blocks it (1.4-1.9 s for that base), after 1 s
  without input when it can. A rewrite is forced when the incr file reaches 64 MB and twice the base
  ([durability](durability.md#aof-rewrites)). 16 shards of one database rewriting at once, under write load, all
  finished in rewriters, the slowest in 1.42 s.
- **Replica reads:** a read on another connection can be up to one replication lag stale.
- **Cold start:** a shard that was evicted while idle reloads its AOF on the next command ([measurements](measurements.md)).
  A replica that resets starts empty and is copied again by its primary.
- **No online resharding or moving.** A database keeps its shard count, its regions and its replica regions for
  life.
- **Unsupported:** MONITOR, replication commands (SYNC, PSYNC, REPLICAOF, FAILOVER: vado's replicas are internal),
  SHUTDOWN, DEBUG, MIGRATE, MOVE, SWAPDB, BGSAVE, SAVE, BGREWRITEAOF, ACL, CONFIG SET of anything but data settings,
  CONFIG inside MULTI ([security](security.md#what-clients-can-change)), CLIENT TRACKING and the other
  connection-wide CLIENT subcommands, and SELECT above 0 (use another database name instead).
