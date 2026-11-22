// AOF rewrites that don't stop the shard. Valkey can't fork in wasm, so an inline rewrite blocks the
// shard while it serializes every key and commits the new base (~1.5 s for a 35 MB base). Instead the
// host takes the rewrite (wasm/patches/0004): a ValkeyRewriter object loads the files the rewrite starts
// from (the base, and the incr files before the one Valkey just opened), rewrites them in a Valkey of its
// own, and sends back the new base. The shard writes it to Valkey's temp file while it keeps serving,
// and Valkey swaps it in exactly as if a forked child had written it. Rewriters are their own classes, so
// one never shares an isolate (or its memory limit) with a shard; a shard of class k uses rewriter class k,
// so a database's shards rewriting at once don't all land in one rewriter isolate.
import { DurableObject } from "cloudflare:workers";
import valkeyWasm from "../../wasm/valkey.wasm";
import { ValkeyHost } from "./valkey-host.js";
import { Vfs } from "./vfs.js";
import { command, concat, decodeAll } from "../protocol/resp.js";
import { aofFiles, MANIFEST } from "../replication/replication.js";
import { valkeyArgs } from "./shard.js";
import { AOF_HELPER_TIMEOUT_MS, VFS_CHUNK } from "../constants.js";

const line = (o) => new TextEncoder().encode(JSON.stringify(o) + "\n");
// FNV-1a of the base, sent after it: the shard installs only a base that arrived exactly as it was sent.
const FNV0 = 2166136261;
const fnv = (h, b) => { for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619); return h >>> 0; };
const yieldTurn = () => new Promise((r) => setTimeout(r, 0));

// A JSON line (after the bytes already in `acc`), and whatever arrived after it.
async function readLine(reader, acc = new Uint8Array(0)) {
  for (;;) {
    const i = acc.indexOf(10);
    if (i >= 0) return [JSON.parse(new TextDecoder().decode(acc.subarray(0, i))), acc.subarray(i + 1)];
    if (acc.length > 1 << 20) throw new Error("header too long");
    const { value, done } = await reader.read();
    if (done) throw new Error("connection closed");
    acc = concat([acc, value]);
  }
}

/** Shard side: writes the base for the rewrite Valkey just started to `tmp` (RDB if `rdb`), via `stub`.
 *  `sync` resolves once storage has every write so far. */
export async function rewriteByHelper(host, stub, tmp, rdb, sync, log = {}) {
  const t0 = Date.now(), at = (k) => { log[k] = Date.now() - t0; };
  const { entries } = aofFiles(host);
  const incrs = entries.filter((e) => e.type === "i");
  const before = entries.filter((e) => e.type === "b" || (e.type === "i" && e !== incrs.at(-1))); // the last incr is the new one
  const files = before.map((e) => [e.path, host.fileSize(e.path) ?? 0]);
  const socket = stub.connect("rewrite:6379");
  const timer = setTimeout(() => socket.close(), AOF_HELPER_TIMEOUT_MS);
  try {
    const writer = socket.writable.getWriter(), reader = socket.readable.getReader();
    await writer.write(line({ manifest: before.map((e) => e.line).join("\n") + "\n", files, rdb }));
    // Reading the files is synchronous SQLite work: yield between chunks so requests keep running.
    for (const [path, size] of files) for (let pos = 0; pos < size; pos += VFS_CHUNK) { await writer.write(host.readFile(path, pos, VFS_CHUNK)); await yieldTurn(); }
    at("sentMs");
    log.sentBytes = files.reduce((n, [, size]) => n + size, 0);
    const [head, rest] = await readLine(reader);
    at("headMs");
    if (head.error) throw new Error(`rewriter: ${head.error}`);
    log.baseBytes = head.size;
    host.removeFile(tmp); // one left by a rewrite that a restart cut short
    host.appendFile(tmp, new Uint8Array(0)); // the file must exist even when the base is empty (an empty shard's)
    // Every reply waits for the storage writes before it, so take the base one chunk's commit at a time:
    // a reply then waits for at most one chunk, not for all of the base that arrived ahead of it.
    let got = 0, synced = 0, sum = FNV0, b = rest;
    for (;;) {
      if (b.length) {
        const take = b.subarray(0, head.size - got);
        host.appendFile(tmp, take);
        sum = fnv(sum, take);
        got += take.length;
        b = b.subarray(take.length);
        if (got - synced >= VFS_CHUNK) { await sync(); synced = got; }
      }
      if (got >= head.size) break;
      const r = await reader.read();
      if (r.done) break;
      b = r.value;
    }
    if (got !== head.size) throw new Error(`base cut short: ${got} of ${head.size} bytes`);
    at("receivedMs");
    const [tail] = await readLine(reader, b);
    at("tailMs");
    if (tail.sum !== sum) throw new Error("base checksum mismatch");
    return true;
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}

export class ValkeyRewriter extends DurableObject {
  #busy = false;

  async connect(socket) {
    const writer = socket.writable.getWriter(), reader = socket.readable.getReader();
    if (this.#busy) { await writer.write(line({ error: "busy" })).catch(() => {}); return await writer.close().catch(() => {}); }
    this.#busy = true;
    const sql = this.ctx.storage.sql, vfs = new Vfs(sql, () => null);
    let streaming = false; // after the size line, an error can only cut the base short
    const logs = []; // Valkey's log, sent back with an error
    try {
      const [{ manifest, files, rdb }, rest] = await readLine(reader);
      vfs.clear();
      let b = rest;
      for (const [path, size] of files) {
        vfs.append(path, new Uint8Array(0)); // creates it: an empty incr file must exist too
        for (let got = 0; got < size; ) {
          if (!b.length) { const r = await reader.read(); if (r.done) throw new Error("the shard closed early"); b = r.value; }
          const take = Math.min(size - got, b.length);
          vfs.append(path, b.subarray(0, take));
          got += take;
          b = b.subarray(take);
        }
      }
      vfs.append(MANIFEST, new TextEncoder().encode(manifest));
      vfs.flush();
      // Valkey loads the files as it boots; the rewrite then runs inline, blocking only this object.
      // import-mode: no expiry or eviction here, so the base keeps a key that expired after the shard's
      // rewrite started (the shard may have PERSISTed it since). A forked child never expires keys either.
      const host = new ValkeyHost(valkeyWasm, sql, { args: [...valkeyArgs(this.env, false), "--aof-use-rdb-preamble", rdb ? "yes" : "no", "--import-mode", "yes"], log: (l) => logs.push(l) });
      const [reply] = decodeAll(await host.execBatch(command(["BGREWRITEAOF"]), 1));
      if (reply?.err) throw new Error(reply.err);
      const { base } = aofFiles(host), size = host.fileSize(base);
      // Socket writes wait for this object's storage writes (the files) to be confirmed. Wait here, and
      // below hold the connection until the shard closes it, so nothing still queued is dropped.
      await this.ctx.storage.sync();
      streaming = true;
      await writer.write(line({ size }));
      let sum = FNV0;
      for (let pos = 0; pos < size; pos += VFS_CHUNK) { const c = host.readFile(base, pos, VFS_CHUNK); sum = fnv(sum, c); await writer.write(c); }
      await writer.write(line({ sum }));
      while (!(await reader.read()).done); // the shard closes once it has checked the base
      await writer.close().catch(() => {});
    } catch (e) {
      if (streaming) await writer.abort(e).catch(() => {});
      else await writer.write(line({ error: [e.message, ...logs.slice(-4)].join(" | ") })).then(() => writer.close()).catch(() => {});
    } finally {
      vfs.clear(); // only copies, kept for the job
      this.#busy = false;
    }
  }
}

// The same object under other class names, one per shard class (see #rewriter in shard.js).
export class ValkeyRewriter1 extends ValkeyRewriter {}
export class ValkeyRewriter2 extends ValkeyRewriter {}
export class ValkeyRewriter3 extends ValkeyRewriter {}
export class ValkeyRewriter4 extends ValkeyRewriter {}
export class ValkeyRewriter5 extends ValkeyRewriter {}
export class ValkeyRewriter6 extends ValkeyRewriter {}
export class ValkeyRewriter7 extends ValkeyRewriter {}
