// AOF rewrites that don't stop the shard. Valkey can't fork in wasm, so an inline rewrite blocks the
// shard while it serializes every key and commits the new base (~1.5 s for a 35 MB base). Instead the
// host takes the rewrite (wasm/patches/0004): a ValkeyRewriter object loads the files the rewrite starts
// from (the base, and the incr files before the one Valkey just opened), rewrites them in a Valkey of its
// own, and sends back the new base. The shard writes it to Valkey's temp file while it keeps serving,
// and Valkey swaps it in exactly as if a forked child had written it. Rewriters are their own class, so
// one never shares an isolate (or its memory limit) with a shard.
import { DurableObject } from "cloudflare:workers";
import valkeyWasm from "../vendor/valkey.wasm";
import { ValkeyHost } from "./valkey-host.js";
import { Vfs } from "./vfs.js";
import { command, concat, decodeAll } from "./resp.js";
import { aofFiles, MANIFEST } from "./replication.js";
import { valkeyArgs } from "./shard.js";
import { AOF_HELPER_TIMEOUT_MS, VFS_CHUNK } from "./constants.js";

const line = (o) => new TextEncoder().encode(JSON.stringify(o) + "\n");

// A JSON header line, and whatever arrived after it.
async function readLine(reader) {
  let acc = new Uint8Array(0);
  for (;;) {
    const i = acc.indexOf(10);
    if (i >= 0) return [JSON.parse(new TextDecoder().decode(acc.subarray(0, i))), acc.subarray(i + 1)];
    if (acc.length > 1 << 20) throw new Error("header too long");
    const { value, done } = await reader.read();
    if (done) throw new Error("connection closed");
    acc = concat([acc, value]);
  }
}

/** Shard side: writes the base for the rewrite Valkey just started to `tmp` (RDB if `rdb`), via `stub`. */
export async function rewriteByHelper(host, stub, tmp, rdb) {
  const { entries } = aofFiles(host);
  const incrs = entries.filter((e) => e.type === "i");
  const before = entries.filter((e) => e.type === "b" || (e.type === "i" && e !== incrs.at(-1))); // the last incr is the new one
  const files = before.map((e) => [e.path, host.fileSize(e.path) ?? 0]);
  const socket = stub.connect("rewrite:6379");
  const timer = setTimeout(() => socket.close(), AOF_HELPER_TIMEOUT_MS);
  try {
    const writer = socket.writable.getWriter(), reader = socket.readable.getReader();
    await writer.write(line({ manifest: before.map((e) => e.line).join("\n") + "\n", files, rdb }));
    for (const [path, size] of files) for (let pos = 0; pos < size; pos += VFS_CHUNK) await writer.write(host.readFile(path, pos, VFS_CHUNK));
    const [head, rest] = await readLine(reader);
    if (head.error) throw new Error(`rewriter: ${head.error}`);
    host.removeFile(tmp); // one left by a rewrite that a restart cut short
    let got = 0;
    for (let b = rest; ; ) {
      if (b.length) { host.appendFile(tmp, b); got += b.length; }
      if (got >= head.size) break;
      const { value, done } = await reader.read();
      if (done) break;
      b = value;
    }
    if (got !== head.size) throw new Error(`base cut short: ${got} of ${head.size} bytes`);
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
    try {
      const [{ manifest, files, rdb }, rest] = await readLine(reader);
      vfs.clear();
      let b = rest;
      for (const [path, size] of files) {
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
      const host = new ValkeyHost(valkeyWasm, sql, { args: [...valkeyArgs(this.env, false), "--aof-use-rdb-preamble", rdb ? "yes" : "no", "--import-mode", "yes"] });
      const [reply] = decodeAll(await host.execBatch(command(["BGREWRITEAOF"]), 1));
      if (reply?.err) throw new Error(reply.err);
      const { base } = aofFiles(host), size = host.fileSize(base);
      streaming = true;
      await writer.write(line({ size }));
      for (let pos = 0; pos < size; pos += VFS_CHUNK) await writer.write(host.readFile(base, pos, VFS_CHUNK));
      await writer.close();
    } catch (e) {
      if (streaming) await writer.abort(e).catch(() => {});
      else await writer.write(line({ error: e.message })).then(() => writer.close()).catch(() => {});
    } finally {
      vfs.clear(); // only copies, kept for the job
      this.#busy = false;
    }
  }
}
