# Life of a command

What happens between a client sending `SET k v` and reading `+OK`.

1. **Connect.** A TCP Worker, a service binding's `connect()`, or `/ws` hands the Worker a socket, and it starts a
   `Router`. The database is the host the caller dialed (`env.VALKEY.connect("mydb:6379")`); an IP address or
   `localhost` means `default`.
2. **AUTH.** With `VALKEY_PASSWORD` set, every command but AUTH, HELLO and QUIT gets `NOAUTH` until the client
   authenticates, and requests are capped at 64 KB. `AUTH <db> <password>` compares the password in constant time,
   and the username picks the database. Looking up a database is an RPC to the catalog (cached per isolate), so
   later requests wait for it to keep their order.
3. **Parse.** `request()` cuts one RESP request from the buffered bytes. A request over the size limit gets
   `ERR Protocol error: invalid bulk length` and the connection closes, as Valkey does.
4. **Route.** The router finds the command's keys from Valkey's `COMMAND` table, hashes each key to one of 16,384
   slots (CRC16, with `{hashtag}` support), and maps the slot to a shard by contiguous ranges.
   - **One slot:** the request bytes go unchanged to that shard's upstream, pipelined.
   - **Splittable multi-key** (MGET, MSET, DEL, UNLINK, EXISTS, TOUCH): one request per shard, replies merged in key
     order.
   - **Whole database** (SCAN, KEYS, DBSIZE, FLUSHALL, INFO): RPC to every shard, 32 at a time. These wait for every
     earlier reply on the connection, and later requests wait for them, so a DBSIZE after a DEL sees the DEL.
   - **Pub/sub:** the database's pub/sub shard.
5. **Run.** The shard's host feeds the bytes to a Valkey client file descriptor and steps Valkey's event loop.
   Valkey executes the command and appends it to its AOF. The filesystem writes that append to SQLite before the
   call returns, and the Durable Object's output gate holds every outgoing byte until the write is committed.
6. **Reply.** The router matches the reply to its request, writes replies in request order, and batches every reply
   ready in the same microtask into one write.

## What a reply does and doesn't tell you

| Observation | Meaning |
| --- | --- |
| A normal reply to a write | The write is committed to the shard's SQLite. It survives resets and deploys |
| `ERR shard connection lost; the command may or may not have run` | The shard reset while the command was in flight. Retry only if the command is safe to repeat |
| A read-only command succeeds after a reset | The router retried it once on a fresh connection. Writes are never retried |
| `EXEC` returns a null reply | A WATCHed key's shard reset, so the transaction didn't run (the same reply as a broken WATCH in Valkey) |
| `CROSSSLOT` | The command needs its keys in one slot. Use a `{hashtag}` |
| The server closes the connection | A protocol error or size limit (an error reply comes first), a WebSocket client that sent too fast, or the Worker restarting |
