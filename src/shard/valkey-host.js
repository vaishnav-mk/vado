// Runs one Valkey (valkey.wasm, patched: host-supplied argv, fork-free AOF rewrite) in a Durable
// Object: sockets from connect(socket) become Valkey client fds; files live in DO SQLite (Vfs).
import { Vfs } from "./vfs.js";
import { frameEnd } from "../protocol/resp.js";
import { CLIENT_HIGH_WATER, CLIENT_LOW_WATER, POOL_MAX, SHARD_COMMITS, SHARD_HIGH_WATER, SHARD_LOW_WATER, VFS_SWEEP_BYTES, VFS_SWEEP_MS } from "../constants.js";

const FD_BASE = 4096; // valkey-wasm sock_shim: fds >= this are host sockets
const AE_READABLE = 1;
const AE_WRITABLE = 2;
const ENOSYS = 52;
const QUIT = new TextEncoder().encode("*1\r\n$4\r\nQUIT\r\n");
// A view of wasm memory, rebuilt only when the memory grows (which replaces its buffer).
const viewOf = (memory, View) => { let v = null; return () => (v?.buffer === memory().buffer ? v : (v = new View(memory().buffer))); };
const HELLO3 = new TextEncoder().encode("*2\r\n$5\r\nHELLO\r\n$1\r\n3\r\n");

export class ValkeyHost {
  #vk;
  #vfs;
  #nextFd = FD_BASE;
  #freeFds = []; // closed fds, reused first: Valkey rejects fds past its setsize (maxclients + 128)
  #socks = new Map(); // fd -> { chunks, off, eof, writer, done, internal }
  #pending = [];
  #listenFd = -1;
  #queued = false;
  #timer = null;
  #hzMs = 100;
  #log;
  #total = 0; // unacknowledged reply bytes across all clients
  #lastTick = 0; // Date.now() of the last step taken by a waiting exec
  #pool = { 2: [], 3: [] }; // idle internal clients for execBatch, by RESP protocol
  #stalled = new Set(); // wake functions of readers paused by the total budget
  bootMs = 0;
  // (tmp, rdb) => null, or an async () => ok that writes the base for an AOF rewrite Valkey just started
  // to `tmp` (patches/0004). null: Valkey rewrites inline, blocking, as before.
  onRewrite = null;
  rewriting = null; // a Promise while a rewrite taken by onRewrite runs
  rewriteDoneMs = null; // the last one's finish: Valkey's swap plus its storage commit
  lastActive = 0; // Date.now() of the last client input: on sockets (not quiet ones), or set by the shard for RPCs

  #sync; // () => Promise: resolves when every storage write so far is confirmed (group commit), or null
  #commits = 0; // AOF commits in flight; at SHARD_COMMITS, input waits for one, then runs in one pass

  constructor(module, sql, { args = [], log = (l) => console.log("[valkey]", l), sync = null } = {}) {
    this.#sync = sync;
    this.#log = log;
    const memory = () => this.#vk.exports.memory;
    this.#vfs = new Vfs(sql, memory);
    this.#vfs.onTrash = () => this.#sweep();
    this.#sweep(); // left from before a restart
    const t0 = Date.now();
    this.#vk = new WebAssembly.Instance(module, this.#imports(module, memory));
    this.#vk.exports._initialize();
    const enc = new TextEncoder().encode(args.map((a) => a + "\0").join(""));
    if (enc.length > this.#vk.exports.rk_args_cap()) throw new Error("valkey args too long");
    new Uint8Array(memory().buffer).set(enc, this.#vk.exports.rk_args_ptr());
    const rc = this.#vk.exports.rk_boot_args(enc.length); // full init, including loading the AOF
    if (rc !== 0) throw new Error(`valkey boot failed (${rc})`);
    this.#hzMs = Math.max(20, this.#vk.exports.rk_next_timeout_ms() || 100);
    this.bootMs = Date.now() - t0; // only advances across I/O in prod; meaningful locally
  }

  #imports(module, memory) {
    const dv = viewOf(memory, DataView);
    let clockMs = -1, clockNs = 0n; // Valkey reads the clock ~10 times a step; it only moves across I/O
    const out = { 1: "", 2: "" };
    const vfs = this.#vfs.imports();
    const wasi = {
      ...vfs,
      environ_sizes_get: (c, s) => (dv().setUint32(c, 0, true), dv().setUint32(s, 0, true), 0),
      environ_get: () => 0,
      args_sizes_get: (c, s) => (dv().setUint32(c, 0, true), dv().setUint32(s, 0, true), 0),
      args_get: () => 0,
      // Workers clocks advance only across I/O; Valkey re-reads the clock every step.
      clock_time_get: (_id, _p, ptr) => {
        const ms = Date.now();
        if (ms !== clockMs) { clockMs = ms; clockNs = BigInt(ms) * 1_000_000n; }
        dv().setBigUint64(ptr, clockNs, true);
        return 0;
      },
      clock_res_get: (_id, ptr) => (dv().setBigUint64(ptr, 1_000_000n, true), 0),
      random_get: (ptr, len) => (crypto.getRandomValues(new Uint8Array(memory().buffer, ptr, len)), 0),
      poll_oneoff: (_i, _o, _n, nev) => (dv().setUint32(nev, 0, true), 0),
      sched_yield: () => 0,
      proc_exit: (code) => { throw new Error(`valkey exited with code ${code}`); },
      fd_write: (fd, iovs, iovsLen, nwrittenPtr) => {
        const mem = memory().buffer, view = dv(), chunks = [];
        let n = 0;
        for (let i = 0; i < iovsLen; i++) {
          const p = view.getUint32(iovs + i * 8, true), len = view.getUint32(iovs + i * 8 + 4, true);
          chunks.push(new Uint8Array(mem, p, len));
          n += len;
        }
        const rc = this.#vfs.write(fd, chunks);
        if (rc === null) {
          if (fd !== 1 && fd !== 2) return 8; // EBADF
          const lines = (out[fd] + chunks.map((c) => new TextDecoder().decode(c)).join("")).split("\n");
          out[fd] = lines.pop();
          for (const l of lines) if (l) this.#log(l);
        } else if (rc !== 0) return rc;
        dv().setUint32(nwrittenPtr, n, true);
        return 0;
      },
    };
    // Anything else the module imports from WASI gets ENOSYS rather than failing to link.
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.module === "wasi_snapshot_preview1" && !(imp.name in wasi && wasi[imp.name])) wasi[imp.name] = () => ENOSYS;
    }
    return {
      wasi_snapshot_preview1: wasi,
      host: this.#hostImports(memory),
      env: { __c_longjmp: new WebAssembly.Tag({ parameters: ["i32"] }) },
    };
  }

  #hostImports(memory) {
    const mem = viewOf(memory, Uint8Array);
    const dv = viewOf(memory, DataView);
    return {
      socket: () => this.#freeFds.pop() ?? this.#nextFd++,
      listen: (fd) => ((this.#listenFd = fd), 0),
      accept: (fd) => (fd === this.#listenFd && this.#pending.length ? this.#pending.shift() : -1),
      read: (fd, ptr, len) => {
        const s = this.#socks.get(fd);
        if (!s) return -1;
        if (!s.chunks.length) return s.eof ? 0 : -1;
        const m = mem();
        let n = 0;
        while (n < len && s.chunks.length) {
          const head = s.chunks[0];
          const take = Math.min(head.length - s.off, len - n);
          m.set(head.subarray(s.off, s.off + take), ptr + n);
          n += take;
          s.off += take;
          if (s.off === head.length) { s.chunks.shift(); s.off = 0; }
        }
        return n;
      },
      write: (fd, ptr, len) => {
        const s = this.#socks.get(fd);
        if (!s || s.eof) return -1;
        // Valkey hands us everything; flow control is on the read side (serve() stops reading
        // while too many reply bytes are unacknowledged), so this stays bounded.
        s.inflight += len;
        this.#total += len;
        s.writer.write(mem().slice(ptr, ptr + len)).then(() => {
          s.inflight -= len;
          this.#total -= len;
          this.#wakeReaders(s);
        }, () => { s.inflight -= len; this.#total -= len; s.eof = true; this.#wakeReaders(s); this.#schedule(); });
        return len;
      },
      close: (fd) => {
        const s = this.#socks.get(fd);
        if (!s) return;
        this.#socks.delete(fd);
        this.#freeFds.push(fd);
        s.done();
        this.#updateTimer();
      },
      aof_rewrite: (ptr, len, rdb, gen) => {
        const tmp = new TextDecoder().decode(mem().slice(ptr, ptr + len));
        const job = !this.rewriting && this.onRewrite?.(tmp, rdb === 1);
        if (!job) return 0;
        this.rewriting = (async () => {
          await null; // after the wasm call that started the rewrite has returned
          let ok = false;
          try { ok = await job(); } catch (e) { this.#log(`rewrite: ${e?.stack ?? e}`); }
          try {
            // Valkey renames tmp into place and swaps the manifest, as when a forked child exits. 0: that
            // rewrite was killed meanwhile (and maybe another started), so tmp is a leftover.
            const t = Date.now(); // the clock moves only across I/O: the sync below makes this include the swap
            if (!this.#vk.exports.rk_rewrite_done(ok ? 1 : 0, gen)) this.#vfs.remove(tmp);
            await this.#sync?.();
            this.rewriteDoneMs = Date.now() - t;
          } finally {
            this.rewriting = null;
            this.#schedule();
          }
        })();
        return 1;
      },
      poll: (interestPtr, count, firedPtr, max) => {
        const view = dv();
        let fired = 0;
        for (let i = 0; i < count && fired < max; i++) {
          const fd = view.getInt32(interestPtr + i * 8, true);
          const mask = view.getInt32(interestPtr + i * 8 + 4, true);
          let ready = 0;
          if (fd === this.#listenFd) {
            if (mask & AE_READABLE && this.#pending.length) ready |= AE_READABLE;
          } else {
            const s = this.#socks.get(fd);
            if (s) {
              if (mask & AE_READABLE && (s.chunks.length || s.eof)) ready |= AE_READABLE;
              if (mask & AE_WRITABLE) ready |= AE_WRITABLE;
            }
          }
          if (ready) {
            view.setInt32(firedPtr + fired * 8, fd, true);
            view.setInt32(firedPtr + fired * 8 + 4, ready, true);
            fired++;
          }
        }
        return fired;
      },
    };
  }

  /** Bytes held for something other than replies (a primary's replication stream): reading pauses on them too. */
  hold(n) { this.#total += n; }
  release(n) { this.#total -= n; this.#wakeReaders(null); }

  #wakeReaders(s) {
    if (s?.wake && s.inflight <= CLIENT_LOW_WATER && this.#total <= SHARD_HIGH_WATER) { const w = s.wake; s.wake = null; w(); }
    if (this.#total <= SHARD_LOW_WATER && this.#stalled.size) {
      const all = [...this.#stalled];
      this.#stalled.clear();
      for (const w of all) w();
    }
  }

  // rk_tick (newer builds) runs beforeSleep after the pass, so one call reads, runs, writes the AOF and
  // flushes replies. rk_step runs it before the pass, so a wake needs two.
  step() {
    const vk = this.#vk.exports;
    try { vk.rk_tick ? vk.rk_tick() : vk.rk_step(); } catch (e) { this.#log(`rk_step threw: ${e?.stack ?? e}`); throw e; }
  }

  #schedule() {
    if (this.#queued) return;
    this.#queued = true;
    if (this.#commits < SHARD_COMMITS) queueMicrotask(() => this.#wake());
  }

  // Group commit: every socket's data used to get its own pass, so its own AOF write and SQLite commit
  // (~4 SETs each under load). While a commit is in flight its replies are held by the output gate anyway,
  // so input that arrives meanwhile waits for it and then runs in one pass, with one commit.
  #wake() {
    this.#queued = false;
    const flushes = this.#vfs.stats.writes;
    this.step();
    if (!this.#vk.exports.rk_tick) this.step();
    if (this.#sync && this.#vfs.stats.writes !== flushes) {
      this.#commits++;
      this.#sync().catch(() => {}).finally(() => { this.#commits--; if (this.#queued) this.#wake(); });
    }
  }

  // serverCron runs only while clients are connected, so an idle object can be evicted.
  // Its data is in SQLite, and Valkey expires stale keys lazily after it reloads.
  #updateTimer() {
    const clients = [...this.#socks.values()].some((s) => !s.internal);
    if (clients && !this.#timer) this.#timer = setInterval(() => this.step(), this.#hzMs);
    else if (!clients && this.#timer) { clearInterval(this.#timer); this.#timer = null; }
  }

  // Deletes the chunks of deleted files a little at a time, in the background.
  #sweeping = false;
  async #sweep() {
    if (this.#sweeping) return;
    this.#sweeping = true;
    try {
      await null; // not inside the wasm call that deleted the file
      while (this.#vfs.sweep(VFS_SWEEP_BYTES)) await new Promise((r) => setTimeout(r, VFS_SWEEP_MS));
    } catch (e) {
      this.#log(`vfs sweep: ${e?.message ?? e}`);
    } finally {
      this.#sweeping = false;
    }
  }

  #open(writer, internal) {
    const fd = this.#freeFds.pop() ?? this.#nextFd++;
    let done;
    const closed = new Promise((r) => (done = r));
    const s = { fd, chunks: [], off: 0, eof: false, writer, done, internal, inflight: 0, wake: null };
    this.#socks.set(fd, s);
    this.#pending.push(fd);
    this.#updateTimer();
    return { s, closed };
  }

  // One TCP client = one Valkey client fd. Resolves when Valkey closes the fd. A quiet socket (a replica's
  // stream from its primary) isn't client activity.
  async serve(socket, greeting = null, quiet = false) {
    const writer = socket.writable.getWriter();
    if (greeting) writer.write(new TextEncoder().encode(greeting)).catch(() => {});
    const { s, closed } = this.#open(writer, false);
    this.#schedule();
    const reader = socket.readable.getReader();
    (async () => {
      for (;;) {
        // Backpressure: a client that isn't reading its replies stops being read.
        while (!s.eof && (s.inflight > CLIENT_HIGH_WATER || this.#total > SHARD_HIGH_WATER)) {
          await new Promise((r) => { if (this.#total > SHARD_HIGH_WATER) this.#stalled.add(r); s.wake = r; });
        }
        const { value, done } = await reader.read();
        if (done) break;
        s.chunks.push(value);
        if (!quiet) this.lastActive = Date.now();
        this.#schedule();
      }
    })().catch(() => {}).finally(() => { s.eof = true; this.#schedule(); });
    await closed;
    await s.writer.close().catch(() => {});
  }

  // Runs RESP request bytes through a throwaway in-process client and returns the raw reply bytes.
  // A trailing QUIT makes Valkey flush every reply and then close the fd; its +OK is stripped.
  async exec(bytes) {
    const out = [];
    const writer = { write: async (b) => { out.push(b); }, close: async () => {} };
    const { s, closed } = this.#open(writer, true);
    let done = false;
    closed.then(() => { done = true; });
    s.chunks.push(bytes, QUIT);
    // Read + run, write replies (beforeSleep), then free the QUIT client (next beforeSleep).
    for (let i = 0; i < 6 && this.#socks.has(s.fd); i++) this.step();
    // Still running (a blocking command, or a backlog): each waiting exec keeps its own timer, so no
    // exec depends on another request's timer staying alive, but the host steps at most once per
    // millisecond however many are waiting.
    while (!done && this.#socks.has(s.fd)) {
      await new Promise((r) => setTimeout(r, 1));
      const now = Date.now();
      if (now !== this.#lastTick) { this.#lastTick = now; this.step(); }
    }
    await closed;
    const all = new Uint8Array(out.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of out) { all.set(b, o); o += b.length; }
    return all.subarray(0, all.length - 5); // "+OK\r\n" from QUIT
  }

  // Runs `bytes` (exactly `count` commands) on a pooled internal client and returns their `count`
  // replies. Reusing clients avoids a connection setup and teardown (accept, create, QUIT, free) per
  // RPC batch, which saturated shards when hundreds of routers sent batches at once. Commands that
  // leave connection state behind (WATCH, SUBSCRIBE, CLIENT REPLY) never come through here.
  async execBatch(bytes, count, proto = 2) {
    const c = this.#pool[proto].pop() ?? (await this.#pooled(proto));
    const out = await this.#batch(c, bytes, count);
    if (c.alive && this.#pool[proto].length < POOL_MAX) this.#pool[proto].push(c);
    else if (c.alive) { c.alive = false; c.s.chunks.push(QUIT); this.#schedule(); }
    return out;
  }

  async #pooled(proto) {
    const c = { alive: true, acc: new Uint8Array(0), pos: 0, frames: 0, want: 0 };
    const writer = { write: (b) => { this.#pooledOutput(c, b); return Promise.resolve(); }, close: async () => {} };
    const { s, closed } = this.#open(writer, true);
    c.s = s;
    closed.then(() => { c.alive = false; });
    if (proto === 3) await this.#batch(c, HELLO3, 1);
    return c;
  }

  #pooledOutput(c, b) {
    if (c.acc.length) { const a = new Uint8Array(c.acc.length + b.length); a.set(c.acc); a.set(b, c.acc.length); c.acc = a; } else c.acc = b;
    for (let e; c.frames < c.want && (e = frameEnd(c.acc, c.pos, c.acc.length)) >= 0; c.pos = e) {
      if (c.acc[c.pos] !== 62) c.frames++; // RESP3 pushes aren't replies
    }
  }

  async #batch(c, bytes, count) {
    Object.assign(c, { acc: new Uint8Array(0), pos: 0, frames: 0, want: count });
    c.s.chunks.push(bytes);
    const finished = () => c.frames >= c.want || !c.alive;
    for (let i = 0; i < 6 && !finished(); i++) this.step();
    while (!finished()) { // a blocking command, or a backlog: same deduped wait as exec()
      await new Promise((r) => setTimeout(r, 1));
      const now = Date.now();
      if (now !== this.#lastTick) { this.#lastTick = now; this.step(); }
    }
    c.want = 0;
    return c.acc.slice(0, c.pos); // replies cut short by a closed client come back incomplete
  }

  stats() {
    return {
      wasmMemoryBytes: this.#vk.exports.memory.buffer.byteLength,
      sockets: [...this.#socks.values()].filter((x) => !x.internal).length, // client connections (routers, direct)
      pooled: this.#pool[2].length + this.#pool[3].length, // idle internal clients kept for RPC batches
      cronRunning: !!this.#timer,
      vfs: this.#vfs.stats,
    };
  }

  files() { return this.#vfs.listing(); }
  readFile(path, pos, len) { return this.#vfs.read(path, pos, len); }
  appendFile(path, bytes) { this.#vfs.append(path, bytes); }
  removeFile(path) { this.#vfs.remove(path); }
  flushFiles() { this.#vfs.flush(); }
  fileSize(path) { return this.#vfs.size(path); }
  set onAppend(f) { this.#vfs.onAppend = f; }
}
