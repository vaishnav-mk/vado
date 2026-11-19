# vado

Valkey on Cloudflare Durable Objects.

Each shard is a Durable Object running real Valkey 9.1, compiled to WebAssembly. Its append-only file lives in the
object's SQLite storage. A router in the Worker spreads keys over the shards by hash slot, so clients see one ordinary
Valkey server. Stock clients (ioredis, valkey-cli, valkey-benchmark) work unchanged.

Experimental, and not an official Cloudflare product.

## How it works

```
client ──RESP──▶ Worker (router) ──▶ ValkeyShard DO 0 ┐
                   │                  ValkeyShard DO 1 ├─ valkey.wasm, AOF in DO SQLite
                   │                  ...              ┘
                   └──▶ Catalog DO (databases and their shard counts)
```

- **Shards.** `ValkeyShard` runs `vendor/valkey.wasm` with a small host:
  - sockets, event-loop stepping and backpressure;
  - a WASI filesystem on DO SQLite (`src/vfs.js`).

  Valkey runs with `appendonly yes` and `appendfsync always`. An AOF append is written to SQLite before Valkey's
  reply leaves, and the Durable Object output gate holds the reply until that write is durable. **An acknowledged
  write survives crashes, restarts and deploys.**
- **Router.** One router per client connection.
  - Single-key and same-slot commands go to their shard over a socket, pipelined.
  - MGET, MSET, DEL, UNLINK, EXISTS and TOUCH split across shards and merge.
  - SCAN, KEYS, DBSIZE, FLUSHALL and INFO cover every shard.
  - Other multi-key commands across slots return `CROSSSLOT`, as in Redis Cluster.
  - MULTI/EXEC, WATCH and Lua need their keys in one slot (use `{hashtags}`).
  - Pub/sub goes through one object per database.
  - Past a per-isolate socket budget, batches go over RPC to pooled internal clients instead.
- **Databases.** A database is created on first use, and its shard count is fixed when it is created: explicitly, or by
  the `SHARD_EPOCHS` entry in force at the time. Adding an epoch sizes new databases without moving existing ones. A
  1-shard database has no cross-slot restrictions.

## Use it

### From a Worker

```jsonc
// wrangler.jsonc of the client Worker
{ "services": [{ "binding": "VALKEY", "service": "valkey-do" }] }
```

```js
import Redis from "ioredis";
import { bindingConnector } from "./client.js"; // src/client.js

export default {
  async fetch(req, env) {
    const redis = new Redis({ Connector: bindingConnector(env.VALKEY, "mydb"), password: env.VALKEY_PASSWORD });
    await redis.set("hello", "world");
    return new Response(await redis.get("hello"));
  },
};
```

Raw RESP works too: `env.VALKEY.connect("mydb:6379")`. The host names the database.

### From anywhere

The Worker serves raw RESP over a WebSocket at `/ws`. `scripts/ws-shim.mjs` turns that back into a local TCP port:

```sh
node scripts/ws-shim.mjs wss://<your-worker>.workers.dev/ws 6379
valkey-cli -p 6379 --user mydb --pass "$VALKEY_PASSWORD"     # AUTH <database> <password>
```

`/ws` is only served when `VALKEY_PASSWORD` is set. Connections start unauthenticated, and `AUTH <db> <password>` or
`HELLO 3 AUTH <db> <password>` picks the database.

### Over raw TCP

With a TCP Worker (a Spectrum application of type Workers (tcp) with this Worker as origin), stock clients connect
directly:

```sh
valkey-cli -h <app-hostname> -p 6379 --user mydb --pass "$VALKEY_PASSWORD"
```

The database comes from `AUTH`, as with the WebSocket path. Without TLS on the Spectrum application the password
travels in plaintext.

## Configure

| Var | Default | Meaning |
| --- | --- | --- |
| `VALKEY_PASSWORD` (secret) | unset | Makes AUTH mandatory and enables `/ws` |
| `BENCH_TOKEN` (secret) | unset | Bearer token for the admin and bench API (`src/bench.js`) |
| `SHARD_EPOCHS` | `[{"from":0,"shards":16}]` | `[{ from, shards }]` by creation time in ms. Create a specific size with `GET /db?db=<name>&shards=<n>` |
| `LOCATION_HINT` | unset | Durable Object location hint for shards |
| `VALKEY_MAXMEMORY` | `64mb` | Per shard. The isolate has 128 MB, so keep it at or under 64 MB |
| `VALKEY_MAXMEMORY_POLICY` | `noeviction` | `allkeys-lru` for a cache |
| `VALKEY_AOF_REWRITE_MIN` | `8mb` | AOF size that triggers an (inline) rewrite |
| `ROUTER_IDLE_MS` | `30000` | Idle shard sockets close after this, so idle shards stop billing |
| `ROUTER_SOCKET_BUDGET` | `128` | Shard sockets per isolate before the router uses RPC batches |

## Develop

Needs Node and `wrangler`. `npm install` brings in `workerd` and ioredis.

```sh
npm install
scripts/local.sh fresh      # build with wrangler, run workerd: TCP 127.0.0.1:6380, HTTP 127.0.0.1:8787
scripts/test-local.sh       # the whole local suite
wrangler secret put VALKEY_PASSWORD && wrangler secret put BENCH_TOKEN && wrangler deploy
```

## Tests

- `test/ioredis.mjs`: stock ioredis, covering MULTI, Lua, BLPOP, streams, pub/sub, pipelining and expiry.
- `test/resp3.mjs`: HELLO 3, maps and pushes.
- `test/chunked.mjs`: requests split into 1-byte to 4 KB writes must reassemble exactly; an 8 MB value in 4 KB
  pieces must be parsed in linear time.
- `test/differential.mjs`: the same random command stream against a 1-shard and an N-shard database must give
  identical replies.
- `test/kill9.mjs`: `kill -9` the runtime mid-write; every acknowledged write must survive.
- `test/watch-reset.mjs`: a shard reset between WATCH and EXEC must abort the transaction.
- `test/auth.mjs`: the AUTH gate, database selection, WebSocket ingress, idle socket close, and SQLite rows per write.
- `test/hammer.mjs`: concurrency invariants (exact INCR, conserved WATCH/MULTI transfers, lossless queue, Lua
  atomicity, ordered pub/sub, large values, expiry, connection churn). `CHAOS=1` aborts shards while they run.
- `scripts/prod-hammer.sh`: the stock-client and hammer runs against a deployed Worker (`VADO_URL=...`).

## Limits

- **Memory:** 64 MB of data per shard, since the data lives in Valkey's memory. Larger databases need more shards.
- **Request size:** one request (all its arguments) is at most about 8 MB, since a shard has to hold the request,
  the value and its AOF entry at once. Bigger requests get `ERR Protocol error: invalid bulk length` and that
  connection is closed, as Valkey does. Before AUTH the limit is 64 KB.
- **Cold start:** a shard evicted while idle reloads its AOF on the next command, which takes about 1-2 s for a full
  shard.
- **CPU:** one command is limited to about 30 s of CPU. A shard kept near 100% CPU gets reset by the runtime, so spread
  hot keys.
- **No online resharding:** a database keeps its shard count.
- **Unsupported:** CLIENT TRACKING, MONITOR, replication commands, and SELECT > 0 (use another database name).

## Layout

- `src/index.js`: Worker entry (TCP `connect`, `/ws`, the bench API).
- `src/router.js`: the sharding router.
- `src/shard.js`: the shard DO.
- `src/valkey-host.js`: the wasm host.
- `src/vfs.js`: the SQLite filesystem.
- `src/catalog.js`: databases and their shard counts.
- `src/slots.js`: hash slots and epochs.
- `src/commands.js`: key positions.
- `src/resp.js`: RESP.
- `src/client.js`: the ioredis connector.
- `src/bench.js`: the admin and bench API.
- `vendor/`: the Valkey wasm build, its patch and license (see `vendor/README.md`).
