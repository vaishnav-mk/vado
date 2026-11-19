# Durability and failures

## How a write is stored

Valkey runs with `appendonly yes` and `appendfsync always`. Its files live in a WASI filesystem backed by the shard
object's SQLite (`src/vfs.js`):

- A file is a set of rows of at most 1 MB (`VFS_CHUNK`, under SQLite's row cap).
- Appends to the AOF are written to SQLite synchronously, inside the write call Valkey makes. Other files buffer
  until fsync or close.
- The last row of a file grows in place while it is under 16 KB (`VFS_TAIL`). Rows written are billed, so an
  unpipelined write costs one row.
- File sizes are derived from the rows, never stored separately, so they can't disagree.

A Durable Object holds every outgoing message until its storage writes are committed. So a reply leaves only after
the write behind it is durable, and a batch of pipelined writes shares one commit.

Valkey rewrites the AOF once it has doubled and passed 8 MB (`VALKEY_AOF_REWRITE_MIN`). wasm has no `fork()`, so
the patched build rewrites inline, pausing the shard while it runs.

## When a shard resets

A shard can reset for a deploy, a crash, an exceeded limit, or because the runtime moved it.

- **Acknowledged writes are kept.** The object restarts, Valkey boots, and it replays its AOF from SQLite before it
  serves anything.
- **In-flight commands get `LOST`.** The router can't know whether a command ran before the reset, so it says so:
  `ERR shard connection lost; the command may or may not have run`.
- **Read-only commands retry once.** A non-blocking read outside MULTI and WATCH goes again on a fresh connection.
  Writes never retry.
- **WATCH breaks.** If a WATCHed key's shard resets before EXEC, EXEC returns a null reply and the transaction
  doesn't run.
- **Blocked clients and subscribers lose their wait.** A BLPOP in progress gets `LOST`; a subscriber's connection to
  the pub/sub shard ends, as if the server had restarted.
- **Stale sockets are detected.** A shard greets each router with its instance ID, and a reply that is late makes the
  router check whether the instance changed, so a socket left open by a reset object doesn't hang.

Pub/sub messages are not stored, as in Valkey. A message published while a subscriber's shard resets is lost.

## During a deploy

Objects move to the new code over minutes. Routers already running keep their connections and their old code until
those end. That is why Durable Object methods keep stable names and signatures ([AGENTS.md](../AGENTS.md)).

## Tests that check this

| Test | What must hold |
| --- | --- |
| `test/kill9.mjs` | `kill -9` of the runtime mid-write keeps every acknowledged write |
| `test/watch-reset.mjs` | A reset between WATCH and EXEC aborts the transaction |
| `test/hammer.mjs` with `CHAOS=1` | With shards aborted underneath: exact INCR counts, conserved WATCH/MULTI transfers, a lossless reliable queue, atomic Lua. Anything that failed may or may not have run, so counts are bounded by acknowledged and acknowledged-plus-failed |
| `durability` in the bench API | 20k acknowledged SETs, abort every shard, read every key back |
