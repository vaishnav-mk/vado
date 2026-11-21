# Durability and failures

## How a write is stored

Valkey runs with `appendonly yes` and `appendfsync always`. Its files live in a WASI filesystem backed by the shard
object's SQLite (`src/vfs.js`):

- A file is a set of rows of at most 1 MB (`VFS_CHUNK`, under SQLite's row cap).
- Appends to the AOF are written to SQLite synchronously, by the write or the fsync that follows it
  (`appendfsync always` fsyncs after every AOF write). Other files buffer until fsync or close.
- The last row of a file grows in place while it is under 16 KB (`VFS_TAIL`). Rows written are billed, so an
  unpipelined write costs one row.
- File sizes are derived from the rows, never stored separately, so they can't disagree.

A Durable Object holds every outgoing message until its storage writes are committed. So a reply leaves only after
the write behind it is durable, and a batch of pipelined writes shares one commit.

## Group commit

After each pass of Valkey's event loop that wrote to the AOF, the shard waits for that commit. It keeps at most two
in flight (`SHARD_COMMITS`). Input that arrives meanwhile waits, then runs in one pass: one AOF write, one commit,
and one row for everything that arrived. Replies are held until their own commit either way, so waiting costs no
durability. Under load a commit carries about 100 writes instead of about 4, and rows written per write fell from
about 0.26 to 0.008 ([measurements](measurements.md)).

## AOF rewrites

Valkey's own rewrite trigger is off (`auto-aof-rewrite-percentage 0`), and the shard picks the moment
(`src/shard.js`):

- A rewrite is due once the incr file is at least 8 MB (`AOF_REWRITE_MIN`) and at least as big as the base, as
  Valkey's default rule.
- With a rewriter available, a due rewrite starts at the next check. Without one it would run inline and block
  the shard, so it waits until the shard has had no input for 1 s (`AOF_REWRITE_IDLE_MS`).
- It runs anyway once the incr file reaches 64 MB (`AOF_REWRITE_CAP`) and twice the base, since a restart replays
  the whole incr file (about 1 s per 64 MB).
- A shard that is appending checks its AOF every 2 s (`AOF_CHECK_MS`). No rewrite starts while a replica copy or
  another rewrite runs.

wasm has no `fork()`, so the rewrite runs in a rewriter object instead of a child process (`src/rewriter.js`,
`wasm/patches/0004-host-aof-rewrite.patch`):

1. Valkey opens a new incr file, as it does before forking, and offers the rewrite to the host. It offers it only
   while the AOF is on.
2. The shard sends its rewriter (`ValkeyRewriter`, in the class matching the shard's) the manifest and the base
   and incr files from before the new incr file. It reads them 1 MB at a time and lets requests run in between.
3. The rewriter boots its own Valkey on that copy with `import-mode` on, so nothing expires or is evicted, and the
   new base is exactly the data as of when the new incr file opened. It rewrites inline, blocking only itself, and
   sends back the base followed by an FNV-1a checksum of it.
4. The shard writes the base to Valkey's temp file one 1 MB storage commit at a time, so a reply waits for at most
   one chunk of it, and checks the length and the checksum.
5. The shard calls `rk_rewrite_done`, and Valkey finishes as if a forked child had exited: the temp file becomes the
   base, a new manifest lists it and the new incr file, and the old files are deleted.

Each rewrite carries a generation, Valkey's count of rewrites. If that rewrite was killed meanwhile, Valkey ignores
the finish and the shard deletes the file it wrote. A helper rewrite fails after 120 s (`AOF_HELPER_TIMEOUT_MS`),
or on any error, and Valkey treats it as a failed child. The shard then rewrites inline for 10 minutes
(`AOF_HELPER_RETRY_MS`): blocking, and at quiet moments unless forced. Shard stats report the last helper rewrite as
`lastRewrite`: phase times, bytes sent and received, any error, and `doneMs`, the swap including its commit.

For a 35.6 MB RDB base, a helper rewrite took 5.2-5.9 s end to end while PINGs to the shard stayed at p99
128-175 ms. Inline, the same base blocks the shard for 1.4-1.9 s ([measurements](measurements.md)).

### A reset during a rewrite

- **Before `rk_rewrite_done`,** the manifest in storage is the old one plus the new incr file. The old base and incr
  files hold every write before the new incr file opened, and the new incr file every write since, so a restarted
  shard loads them and never reads the half-written temp file.
- **The swap** (the rename, the new manifest, deleting the old files) is one storage commit, so a restart sees
  either the old manifest and its files or the new ones.
- **A leftover temp file** from a rewrite cut short is removed by the next helper rewrite before it writes.

## When a shard resets

A shard can reset for a deploy, a crash, an exceeded limit, or because the runtime moved it.

- **Acknowledged writes are kept.** The object restarts, Valkey boots, and it replays its AOF from SQLite before it
  serves anything.
- **In-flight commands get `LOST`.** The router can't know whether a command ran before the reset, so it says so:
  `ERR shard connection lost; the command may or may not have run`.
- **Read-only commands retry once.** A non-blocking read outside MULTI and WATCH goes again on a fresh connection.
  A read sent to a replica that fails goes again to the primary. Writes never retry.
- **WATCH breaks.** If a WATCHed key's shard resets before EXEC, EXEC returns a null reply and the transaction
  doesn't run.
- **Blocked clients and subscribers lose their wait.** A BLPOP in progress gets `LOST`; a subscriber's connection to
  the pub/sub shard ends, as if the server had restarted.
- **Stale sockets are detected.** A shard greets each router with its instance ID, and a reply that is late makes the
  router check whether the instance changed, so a socket left open by a reset object doesn't hang.

Pub/sub messages are not stored, as in Valkey. A message published while a subscriber's shard resets is lost.

## Read replicas

Replicas hold nothing durable. A write is acknowledged once the primary has committed it, whatever its replicas
have (`src/replication.js`).

- **What a replica receives.** Every append to the primary's AOF incr file, in order (`Vfs.onAppend`). The stream
  leaves through the primary's output gate like its replies, so a replica only receives committed writes.
  Appends that arrive while a write to a replica is in flight go out together in the next one.
- **The starting copy.** The primary turns the RDB preamble off, waits for a rewrite in progress to finish (it would
  replace the files mid-copy) and, if its base file is RDB, rewrites it as commands, since a replica runs the files
  as commands. If the base is still RDB because that rewrite failed, it drops the copy and tries again later. It then dials the replica (`connect("repl:6379")`), sends
  `CLIENT REPLY OFF` and `FLUSHALL`, the base and incr files in 1 MB chunks, then the appends that arrived during
  the copy. Once no copy is running, the base goes back to RDB at the next rewrite check (the next quiet moment, if
  rewriting inline): RDB is about 6x smaller, so each later rewrite has about 6x less to write.
- **Ready to serve.** After the copy the primary sends a marker (`CLIENT REPLY ON`, `PING`, `CLIENT REPLY OFF`).
  Its `+PONG` means the replica has run everything before it, and only then does the replica serve reads. A marker
  every 2 s (`REPL_TICK_MS`) measures each replica's lag. A replica that receives a new copy stops serving reads
  until it has all of it.
- **A replica resets.** It starts empty and refuses reads. The primary sees the socket close, waits 5 s
  (`REPL_RETRY_MS`) and copies it again. Routers read from the primary meanwhile.
- **A replica falls behind.** Replication bytes not yet sent or acknowledged count toward the primary's 16 MB input
  budget (`SHARD_HIGH_WATER`), so replicas that lag slow the writes down. A replica more than 8 MB behind
  (`REPL_BACKLOG`), or one that hasn't answered a marker for 60 s (`REPL_STUCK_MS`), is dropped and copied again.
- **The primary resets.** Its acknowledged writes are in its AOF. Its replicas keep serving what they have, which
  may miss the last writes before the reset, until the restarted primary copies them again.

### What a read from a replica can see

- **The connection's own writes.** While a connection has a write in flight to a shard, and for 2 s
  (`READ_YOUR_WRITES_MS`) after its reply, that connection reads the shard from its primary. This holds while
  replicas are less than 2 s behind; a replica further behind can return a connection's older value after that.
- **Other connections' writes.** A read on another connection can be up to one replication lag old.
- **Transactions.** Inside MULTI, and while WATCH is active, reads go to the primary.
- **Failures.** A replica that isn't ready, or resets mid-read, ends the router's connection to it. The read goes to
  the primary, and every router in that isolate leaves that replica alone for 5 s (`REPL_RETRY_MS`).

## During a deploy

Objects move to the new code over minutes. Routers already running keep their connections and their old code until
those end. That is why Durable Object methods keep stable names and signatures ([AGENTS.md](../AGENTS.md)).

## Tests that check this

| Test | What must hold |
| --- | --- |
| `test/kill9.mjs` | `kill -9` of the runtime mid-write keeps every acknowledged write |
| `test/watch-reset.mjs` | A reset between WATCH and EXEC aborts the transaction |
| `test/hammer.mjs` with `CHAOS=1` | With shards aborted underneath: exact INCR counts, conserved WATCH/MULTI transfers, a lossless reliable queue, atomic Lua, and pipelines whose only failures are `LOST`. Anything that failed may or may not have run, so counts are bounded by acknowledged and acknowledged-plus-failed |
| `durability` in the bench API | 20k acknowledged SETs (`n=` for more), abort every shard, read every key back |
| `ryw` in the bench API | On one connection, every GET after an acknowledged SET of the same key sees it |
| `staleness` in the bench API | How long after an acknowledged write a second connection still reads the old value |
