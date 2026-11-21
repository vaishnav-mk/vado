# Measurements

Newest first. Each section keeps its numbers as measured; later changes don't rewrite them.

## 2026-11-21: shard classes, allocators and rewriters

Production, one account, on builds up to a56cc53, through the bench API unless noted.

### Isolates

Each shard's stats report an id per isolate (`isolate`).

| Database | Isolates |
| --- | --- |
| 16 shards in one region, every shard in one class | 14, one of them holding 3 shards |
| 16 shards in one region, 8 classes | 16 |
| 4 shards with 36 replicas (`replicas=world`), 8 classes | 40 for the 40 objects |

### Allocators

Bench `frag` with `via=shard` on a 1-shard database: the wasm linear memory, which is what counts against the
isolate's memory, against Valkey's `used_memory`.

| Allocator | Data | Linear memory / `used_memory` |
| --- | --- | --- |
| wasi-libc dlmalloc (the vendored build) | 120k keys of 16-512 B | 1.08x |
| wasi-libc dlmalloc | 400k keys of 8-64 B | 1.20x |
| wasi-libc dlmalloc | Small hashes | 1.09-1.29x |
| mimalloc 3.7.0 (`ALLOCATOR=mimalloc`) | | 1.6-4.3x |

With dlmalloc the ratio stayed flat across 6 rounds of deleting and rewriting half the keys. mimalloc started at
34 MB of linear memory, against 2.6 MB with dlmalloc, and grows in 16 MiB arenas, which is where its higher ratios
come from. Linear memory never shrinks: after
deleting data from 39 MB to 9 MB, it stayed at 44 MB. The vendored build stays on dlmalloc.

### AOF rewrites

Bench `rewrite` with `via=shard`, on a shard with a 35.6 MB RDB base, PINGing the shard during the rewrite. PING
p50 was 42 ms, the client's round trip.

| Rewrite | Time | PINGs during it |
| --- | --- | --- |
| Inline, files stored under their path | 2.5-3.2 s, the shard blocked | max equal to the rewrite |
| Inline, files stored under chunk keys | 1.4-1.9 s, the shard blocked | |
| In a rewriter | 5.2-5.9 s end to end | p99 128-175 ms, max 160-193 ms |

The swap at the end of a rewrite deletes the old base. Bench `vfs` with 32 MB files: deleting a file from the middle
of the database took 455-573 ms in one commit, against 5-22 ms from the end, and the swap took 585-804 ms. With the
deletes moved to a background sweep (2 rows per commit on that build), the swap took 11-23 ms.

16 shards of one database rewriting at once, under write load: all 16 rewrites ran in rewriters and finished, the
slowest in 1.42 s.

| Check, with rewriters | Result |
| --- | --- |
| 50,000 writes made during two rewrites, then a shard restart | 0 missing |
| 300,000 writes, during which the shard started its own rewrite, then a restart | 0 missing |
| The same with replicas in 2 regions, and one replica reset mid-write | Both regions and the restarted primary read back 300,000, 0 missing |

### Checks on this build

Client tests ran from outside Cloudflare over TCP.

| Check | Result |
| --- | --- |
| `test/ioredis.mjs`, `test/resp3.mjs` | Passed |
| `test/hammer.mjs` | 11 of 11 checks held; with `CHAOS=1`, 11 of 11 through 35 shard aborts |
| Bench `durability`: 50,000 acknowledged writes, then every shard aborted | 0 missing |
| Connection churn (connect, AUTH, write, read, close) | 6,995 of 7,000 connections |
| `test/differential.mjs` | Passed |
| 36 replicas (4 shards, 9 regions) | All ready; 20,000 of 20,000 keys read back in each of the 9 regions |

### What these don't show

One account and runs of minutes, test traffic only. The allocator runs used one shard and synthetic data. The
rewrite times are for one base size.

## 2026-11-20 and 21: group commit, rewrite scheduling and read replicas

Production, one account, on builds up to fb43f17. Most numbers come from the bench API, which runs its clients
inside Cloudflare: load generators through the router, Sender objects in each of the nine `world` regions
(`send?region=...`), or straight to one shard (`via=shard`). Each table names its probe where it used one.

### Writes

| Load | Result |
| --- | --- |
| Deep pipelines straight to one shard | 114-130k SET/s, 250-306k GET/s |
| 16 shards through the router, from 8 load generators | 255-304k SET/s with group commit, 48-66k before it |
| Rows written per write, under that load | about 0.008 with group commit, about 0.26 before it |

A write's latency is the network round trip plus one storage commit. Commit time measured from inside a shard
(bench `commit`) was 10-38 ms p50 depending on where the shard ran: 10 ms in Paris, 18 ms in Atlanta, 38 ms in
Singapore.

### AOF rewrites

A rewrite blocks its shard while it runs, since wasm has no `fork()`: about 1 s per 10 MB of RDB base. Under
sustained writes, GET p99 fell from 608-776 ms to 112-141 ms once the shard scheduled its own rewrites. Under the
same load, reads from a replica in the shard's home region stayed at p99 45 ms and max 51 ms, while the primary's
max was 318-1117 ms.

### Read replicas

Replicas in all nine regions (`replicas=world`).

| Check | Result |
| --- | --- |
| Every replica serving reads after the database was created | Within seconds |
| A second client in each of 9 regions reads a write acknowledged to the first (bench `staleness`) | p50 3-41 ms, p99 38-141 ms |
| Keys written, then read back from every region | 20,000 of 20,000 |
| Read-your-writes on one connection (bench `ryw`) | 0 stale in 2,700 checks |
| Writes per shard | 49-61k SET/s with 9 replicas, about 130k with none |

At light load the staleness times are bounded by one read round trip. With 9 replicas, the replication streams
hold back the primary's input (backpressure), and that caps its writes.

### Under failure

| Test | Result |
| --- | --- |
| Bench `durability`: 50,000 acknowledged writes, then every shard aborted | 0 missing, in each of two runs |
| `test/hammer.mjs` with `CHAOS=1` | 11 of 11 checks held through about 20 shard aborts |
| Connection churn (connect, AUTH, write, read, close) | Passed at 7,000 connections. The host before fd reuse stopped accepting after about 6,030: it never reused closed fds, and Valkey refuses fds past its limit |

### Limits seen

- Many connections times many shards pass the router's socket budget. Each connection then sends one RPC per batch:
  200 connections over 16 shards ran at about 20-26k ops/s.
- 9 replicas cut a shard's write throughput to about 50k SET/s.
- A read on another connection can be up to one replication lag stale.

### What these don't show

One account and runs of minutes. Test traffic only, no TLS, no runs of hours, and no eviction under memory
pressure.

## 2026-11-19: first production runs

Production, on Workers Paid, 2026-11-19. Each table names the build it ran on; 37e83b9 differs from 13f71a6 only
in bench API auth and error mapping.

- **Client:** one laptop in Bangalore on a home connection (about 3.2 MB/s up, 5.8 MB/s down).
- **Raw TCP:** a Spectrum application of type Workers (tcp) in front of the Worker, without TLS.
- **Placement:** routers ran in Bangalore. Shards had `LOCATION_HINT=apac`, which placed them 15-45 ms from the
  router, varying per object.
- **Load from inside Cloudflare:** the bench API runs load-generating Workers in the colo the request lands in, and
  they connect through a service binding to the same `connect()` handler as any client.

### Capacity inside Cloudflare

Build 13f71a6. Each request opens 4 connections and sends pipelined SETs in batches of 2,000, with unique keys
spread over every slot and 1-byte values.

| Load | Shards | Result |
| --- | --- | --- |
| 48 requests x 4 connections | 16 | **173k ops/s**, 0 errors |
| 128 x 4 | 64 | **188k ops/s**, 0 errors |
| 160 x 4 | 64 | **219k ops/s**, 0 errors |

The first warm-up on a new 16-shard database failed 47 of 48 requests with Worker error 1102: the load generator's
own isolate ran out of memory, packing many requests' connections into one isolate. The next run reached 72k ops/s,
the third 173k. These are bursts of tens of seconds, not a sustained ceiling.

### Latency over TCP

One connection, one command at a time, `TCP_NODELAY` (as ioredis does). Builds 13f71a6 and 37e83b9.

| Command | p50 | p90 | p99 |
| --- | --- | --- | --- |
| PING (answered by the router) | 10-12 ms | 20-23 ms | 40 ms |
| GET | 54 ms | 61 ms | 95 ms |
| SET | 57-60 ms | 71-75 ms | 173-330 ms |
| New connection: connect, AUTH, PING | 85 ms | 211 ms | |

So the client's hop to the Worker was about 10 ms, and nearly everything else was the Worker's hop to the shard. A
write cost about as much as a read: the storage commit added a few milliseconds here. The bench API, which has no
client hop, measured Worker-to-shard GETs at 43-45 ms p50 on the same databases. Shards placed closer to the router
answered warm GETs in 18-32 ms.

valkey-benchmark with one client reports about 88 ms p50 over this TCP path. That is an interaction between its
socket timing and the proxy's ACKs; a client with `TCP_NODELAY` sees the numbers above.

### Throughput from one client over TCP

Build 13f71a6. `valkey-benchmark -r 100000` from the laptop. These are bound by its round trips, not by the shards.

| Load | Shards | SET | GET | Others |
| --- | --- | --- | --- | --- |
| 200 connections x 64-deep pipelines | 1 | 45.5k/s | 69.7k/s | |
| 200 x 64 | 16 | 18.8k/s | 21.5k/s | |
| 50 x 16 | 1 | 7.3k/s | 9.1k/s | INCR 7.3k, LPUSH 7.2k, HSET 6.8k |

16 shards were slower than 1 from this client. Each router splits its pipeline across 16 shards, and with 200
connections in a few isolates most upstreams are past the socket budget and go as RPC batches. That is the likely
cause, not a measured one. In other runs, about one in four 200-connection runs lost a connection, on TCP and on
the WebSocket path alike, with no matching failure on the server side.

### Cold starts

Build 37e83b9. Fifteen samples, three runs of five.

| Event | Time |
| --- | --- |
| AUTH to a new database (creates its catalog record) | 71-118 ms |
| First SET on a new database (creates the shard object and boots Valkey) | 481-571 ms |
| Next SET | 53-65 ms |
| First GET after the shard is aborted, 16 MB of data (AOF reload) | 170-323 ms |
| First GET after the shard is aborted, 56 MB of data | 271-380 ms |

An aborted shard here restarted in a warm isolate. An object evicted to a new isolate also compiles the wasm first;
that wasn't measured separately.

### Large values over TCP

Build 13f71a6, one connection.

| Size | SET | GET |
| --- | --- | --- |
| 1 MB | 1.0 s | 0.43 s |
| 4 MB | 1.1 s | 0.85 s |
| 8 MB | 1.9 s | 1.8 s |
| 16 MB | refused: `ERR Protocol error: invalid bulk length` | |

Bound by the laptop's link.

### Under failure

| Test | Build | Result |
| --- | --- | --- |
| Bench `durability`: 20,000 acknowledged SETs on 16 shards, then every shard aborted | 13f71a6 | 0 missing, 0 wrong |
| `test/hammer.mjs` over TCP, `CHAOS=1`, 16 shards, 32 clients, 60 s | 13f71a6 | Every invariant held through 27 shard aborts. Clients saw 47 `LOST` errors and 5 dropped connections |

### What these don't show

One client location, one account and a few minutes per run. No TLS on the TCP path. Latency depends on where each
shard lands, which varies per object. Runs of hours, eviction under memory pressure, and many clients spread across
regions weren't measured.
