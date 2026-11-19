# Measurements

Production, on Workers Paid, 2026-11-19. Each table names the build it ran on; 37e83b9 differs from 13f71a6 only
in bench API auth and error mapping.

- **Client:** one laptop in Bangalore on a home connection (about 3.2 MB/s up, 5.8 MB/s down).
- **Raw TCP:** a Spectrum application of type Workers (tcp) in front of the Worker, without TLS.
- **Placement:** routers ran in Bangalore. Shards had `LOCATION_HINT=apac`, which placed them 15-45 ms from the
  router, varying per object.
- **Load from inside Cloudflare:** the bench API runs load-generating Workers in the colo the request lands in, and
  they connect through a service binding to the same `connect()` handler as any client.

## Capacity inside Cloudflare

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

## Latency over TCP

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

## Throughput from one client over TCP

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

## Cold starts

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

## Large values over TCP

Build 13f71a6, one connection.

| Size | SET | GET |
| --- | --- | --- |
| 1 MB | 1.0 s | 0.43 s |
| 4 MB | 1.1 s | 0.85 s |
| 8 MB | 1.9 s | 1.8 s |
| 16 MB | refused: `ERR Protocol error: invalid bulk length` | |

Bound by the laptop's link.

## Under failure

| Test | Build | Result |
| --- | --- | --- |
| Bench `durability`: 20,000 acknowledged SETs on 16 shards, then every shard aborted | 13f71a6 | 0 missing, 0 wrong |
| `test/hammer.mjs` over TCP, `CHAOS=1`, 16 shards, 32 clients, 60 s | 13f71a6 | Every invariant held through 27 shard aborts. Clients saw 47 `LOST` errors and 5 dropped connections |

## What these don't show

One client location, one account and a few minutes per run. No TLS on the TCP path. Latency depends on where each
shard lands, which varies per object. Runs of hours, eviction under memory pressure, and many clients spread across
regions weren't measured.
