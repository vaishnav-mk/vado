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
- **Between objects:** routers, shards and replicas talk over Durable Object sockets and RPC, which only code in this
  Worker can open: a stub needs the `SHARD` binding. Clients reach only the router.

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

The Worker's HTTP API (`src/bench.js`) needs `Authorization: Bearer <BENCH_TOKEN>` and is refused without
`BENCH_TOKEN` set. With the token, anyone can:

- list every database (`dbs`), create databases, and choose their placement and replica regions (`db`);
- read every shard's and replica's stats and Valkey INFO (`stats`, `shards`), and run any command (`run`);
- fill shards, abort shards or replicas (`fill`, `abort`, `durability`), and repoint replication (`replicate`);
- run load from many invocations and from Sender objects in any region (`loadgen`, `send`), which you pay for;
- read what each isolate reported to the Pulse object (`pulse`): every open connection's database and command
  count, plus the client's remote address when the socket reports one, and for WebSocket clients the approximate
  location Cloudflare attaches to the request (city, country, coordinates). Pulse keeps this in memory only.

Treat the token like the password, or leave `BENCH_TOKEN` unset in a deployment you care about.

## The live view

`ui/server.mjs` holds the bench token and the password in its own process, so neither reaches the browser. It
listens on 127.0.0.1 only, and its page has no login: anyone who can reach that port on your machine can run
commands, create databases, restart shards and start paid test traffic. Don't forward the port or bind it
elsewhere.

## Data at rest

Data is stored in Durable Object SQLite storage, with no encryption of its own on top. Replicas keep their copy in
memory only, never in storage. Keys live until you delete or expire them, or until a full shard evicts them under
`allkeys-lru`.
