# Security

## Authentication

- **A shared password, and optional per-database ones.** `VALKEY_PASSWORD` makes AUTH mandatory. The AUTH username
  names the database; there are no users or ACLs within a database.
  - A database created with its own password (bench `/db?password=new`, which returns it once) takes only that
    password over TCP or WebSocket. The catalog keeps a salted SHA-256 of it, never the password; it is 24 random
    bytes, so a fast hash is enough and AUTH stays cheap for clients that connect often.
  - Any other database takes `VALKEY_PASSWORD`, so anyone with that password can use, and FLUSHALL, every database
    without its own.
  - Through a service binding (your own Workers), `VALKEY_PASSWORD` opens every database, including those with their
    own password.
  - AUTH checks the shared password before it looks up or creates a database, so a wrong password creates nothing.
    A database's own password can't be set after it is created, or changed.
- **Without a password, anything that reaches `connect()` is in.** That is fine behind a service binding, which only
  your own Workers can call. Set the password before you put a TCP Worker in front. `/ws` refuses to serve without one.
- **Passwords are compared in constant time.**
- **Failed AUTHs are rate limited.** Each failure counts against the client's address, per Cloudflare location
  (the `AUTH_LIMIT` rate limiting binding, 30 a minute). Past that, the address may not AUTH for a minute and gets
  `ERR too many failed AUTH attempts from this address`, so passwords and database names (an unknown name costs a
  catalog lookup) can't be guessed at speed. Clients behind one address share its limit. Service bindings aren't
  limited.
- **Before AUTH,** only AUTH, HELLO and QUIT run, and requests are capped at 64 KB, so an unauthenticated client can't
  make the router buffer much. An unauthenticated connection runs no command on any database. (A new isolate's
  first connection does look up the `default` database and Valkey's command table, once.)

## What clients can change

The shards' persistence, memory, networking and auth belong to the service, and the router keeps clients away
from them. Without this, any client could turn the AOF off, or raise `maxmemory` past what the isolate holds, on
every shard.

- **`CONFIG SET` takes only settings that change how data behaves.** They are `maxmemory-policy`,
  `maxmemory-samples`, `notify-keyspace-events`, the encoding thresholds (`hash-max-listpack-entries`,
  `hash-max-listpack-value`, `hash-max-ziplist-entries`, `hash-max-ziplist-value`, `list-max-listpack-size`,
  `list-max-ziplist-size`, `list-compress-depth`, `set-max-intset-entries`, `set-max-listpack-entries`, `set-max-listpack-value`,
  `zset-max-listpack-entries`, `zset-max-listpack-value`, `zset-max-ziplist-entries`, `zset-max-ziplist-value`,
  `hll-sparse-max-bytes`, `stream-node-max-bytes`, `stream-node-max-entries`), `lfu-log-factor`, `lfu-decay-time`,
  `slowlog-log-slower-than`, `slowlog-max-len`, `latency-monitor-threshold`, `busy-reply-threshold`,
  `lua-time-limit` and `activerehashing` (`CONFIG_SET` in `src/router/router.js`). Any other setting gets
  `ERR 'config set <name>' is not supported by the sharded router`. An allowed one goes to every primary shard, not
  to replicas or the pub/sub shard, and lasts until that shard restarts and boots with the Worker's settings again.
- **`CONFIG` inside MULTI is refused.**
- **`SAVE` and `BGREWRITEAOF` are refused.** The shards schedule their own persistence.
- **`ACL` is refused.** The router does AUTH itself, and a password set on a shard would lock the routers out.

## Transport

- **TCP Worker:** enable TLS on the Spectrum application (`flexible` terminates TLS at the edge). Without it the AUTH
  password and all data cross the internet in plaintext.
- **WebSocket:** use the `wss://` URL. The shim's local TCP port is plaintext on 127.0.0.1.
- **Service binding:** stays inside Cloudflare.
- **Between objects:** routers, shards, replicas and rewriters talk over Durable Object sockets and RPC, which only
  code in this Worker can open: a stub needs one of the `SHARD` or `REWRITER` bindings. Clients reach only the
  router.

## Replicas

- **A replica is a full copy.** Every key of a shard is copied to each replica region, in memory. Pick replica
  regions with that in mind, as you would `regions`: data that must stay in one region shouldn't go into a database
  with shards or replicas elsewhere.
- **Only a primary feeds a replica.** A replica treats a socket dialed as `repl:6379` as its primary's stream, which
  starts with `FLUSHALL`. Only code in this Worker can dial it (see above).
- **Replica names can't be claimed.** An object whose name ends in `.r.<region>` boots as a memory-only replica.
  Shard names are `<db>.<created>.<i>`, and database names can't contain dots (`DB_NAME`), so no client-chosen
  database maps onto a replica.
- **Names show up in logs.** Object names carry database names, and a primary logs `replica <name> -> <region>
  dropped: <why>` to the Worker's logs. Anyone who can read those logs sees which databases exist.

## The bench API

The Worker's HTTP API (`src/bench/bench.js`) needs `Authorization: Bearer <BENCH_TOKEN>` and is refused without
`BENCH_TOKEN` set. With the token, anyone can:

- list every database (`dbs`), create databases, and choose their placement and replica regions (`db`);
- read every shard's and replica's stats and Valkey INFO (`stats`, `shards`), and run any command (`run`), straight
  to a shard with `via=shard`, past the router's checks above;
- fill or flush shards (`fill`, `frag`), abort shards or replicas (`abort`, `durability`), and repoint replication
  (`replicate`);
- run load from many invocations and from Sender objects in any region (`loadgen`, `send`), which you pay for;
- read what each isolate reported to the Pulse object (`pulse`): every open connection's database and command
  count, plus the client's remote address when the socket reports one, and for WebSocket clients the approximate
  location Cloudflare attaches to the request (city, country, coordinates). Pulse keeps this in memory only.

Treat the token like the password, or leave `BENCH_TOKEN` unset in a deployment you care about.

## The dashboard

The dashboard is public to watch and needs signing in to change anything.

- **Watching** is `/live?db=<name>`, a WebSocket from the database's Watcher. It carries counts, sizes, rates,
  response times and places (city names), never keys, values or client addresses. Anyone who knows a database's
  name can watch it, and the dashboard lists every database's name. Each watched database costs a poll of every
  shard and ready replica a second, and the Watcher's response-time probe is client traffic, so a watched database
  doesn't go to sleep.
- **Signing in** takes `BENCH_TOKEN`. The dashboard sends it to `Admin.session()` and keeps only what comes back: an
  expiring session string signed with the token (HMAC-SHA256, seven days), in an `HttpOnly`, `Secure`,
  `SameSite=Strict` cookie. The token itself is never stored, and changing it signs everyone out.
- **Changing things** (creating a database, running a command, restarting a shard, test traffic) checks the session
  with `Admin.authorized()` on every call. A signed-in person can do what the bench token allows through these
  paths, including FLUSHALL on any database; the router's own checks still apply to commands.
- **`Admin`** is an RPC entrypoint, so only Workers on the account with a service binding to it can call it. It
  returns no password hashes. Test traffic it starts stops by itself after ten minutes (`TEST_TRAFFIC_MS`), or when
  nobody is watching that database any more.

## Data at rest

Data is stored in Durable Object SQLite storage, with no encryption of its own on top. Replicas keep their copy in
memory only, never in storage. A rewriter keeps a copy of its shard's AOF files in its own storage while a rewrite
runs, and deletes it when the rewrite ends, or at the start of the next one if a reset cut it short. Keys live until you delete or expire them, or until a full shard evicts them under
`allkeys-lru`.
