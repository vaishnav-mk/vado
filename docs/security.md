# Security

## Authentication

- **One password for every database.** `VALKEY_PASSWORD` makes AUTH mandatory. The AUTH username names the database;
  there are no per-database users or ACLs. Anyone with the password can use, and FLUSHALL, any database.
- **Without a password, anything that reaches `connect()` is in.** That is fine behind a service binding, which only
  your own Workers can call. Set the password before you put a TCP Worker in front. `/ws` refuses to serve without one.
- **Passwords are compared in constant time.**
- **Before AUTH,** only AUTH, HELLO and QUIT run, and requests are capped at 64 KB, so an unauthenticated client can't
  make the router buffer much. An unauthenticated connection runs no command on any database. (A new isolate's
  first connection does look up the `default` database and Valkey's command table, once.)

## Transport

- **TCP Worker:** enable TLS on the Spectrum application (`flexible` terminates TLS at the edge). Without it the AUTH
  password and all data cross the internet in plaintext.
- **WebSocket:** use the `wss://` URL. The shim's local TCP port is plaintext on 127.0.0.1.
- **Service binding:** stays inside Cloudflare.

## The bench API

The Worker's HTTP API (`src/bench.js`) needs `Authorization: Bearer <BENCH_TOKEN>` and is refused without
`BENCH_TOKEN` set. It can create databases, read stats, fill shards and abort them. Treat the token like the password,
or leave `BENCH_TOKEN` unset in a deployment you care about.

## Data at rest

Data is stored in Durable Object SQLite storage, with no encryption of its own on top. Keys live until you delete or
expire them, or until a full shard evicts them under `allkeys-lru`.
