// AOF rewrites that don't stop the shard. Valkey can't fork in wasm, so an inline rewrite blocks the shard while it
// serializes every key (~1.5 s for a 35 MB base). Instead the host takes the rewrite (wasm/patches/0004): a
// ValkeyRewriter loads the files the rewrite starts from, rewrites them in a Valkey of its own, and sends back the
// new base, which the shard writes to Valkey's temp file while it keeps serving. Rewriters are their own classes,
// so one never shares an isolate (or its memory limit) with a shard.
import { DurableObject } from "cloudflare:workers";
import { decodeAll } from "../../protocol/decode";
import { command } from "../../protocol/resp";
import { aofFiles, MANIFEST } from "../../replication/aof-files";
import { ValkeyHost } from "../host/valkey-host";
import { serverOf } from "../servers";
import { valkeyArgs } from "../valkey-args";
import { deployedAt } from "../version";
import { VFS_CHUNK } from "../vfs/config";
import { Vfs } from "../vfs/vfs";
import { FNV0, fnv, line, readLine } from "./protocol";
import type { RewriteRequest } from "./protocol";

// Loads the shard's files into this object's (scratch) storage.
async function receiveFiles(
  vfs: Vfs,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  { manifest, files }: RewriteRequest,
  rest: Uint8Array,
): Promise<void> {
  let bytes = rest;

  for (const [path, size] of files) {
    vfs.append(path, new Uint8Array(0)); // creates it: an empty incr file must exist too

    for (let got = 0; got < size;) {
      if (!bytes.length) {
        const next = await reader.read();

        if (next.done) throw new Error("the shard closed early");
        bytes = next.value;
      }

      const take = Math.min(size - got, bytes.length);
      vfs.append(path, bytes.subarray(0, take));
      got += take;
      bytes = bytes.subarray(take);
    }
  }

  vfs.append(MANIFEST, new TextEncoder().encode(manifest));
  vfs.flush();
}

export class ValkeyRewriter extends DurableObject<Env> {
  #busy = false;

  /** When this object's code was deployed: a shard compares it with its own to find newer code. */
  deployedAt(): number {
    return deployedAt(this.env);
  }

  override async connect(socket: Socket): Promise<void> {
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();

    if (this.#busy) {
      await writer.write(line({ error: "busy" })).catch(() => {});

      return await writer.close().catch(() => {});
    }

    this.#busy = true;
    let streaming = false; // after the size line, an error can only cut the base short
    const logs: string[] = []; // Valkey's log, sent back with an error

    try {
      const [request, rest] = await readLine<RewriteRequest>(reader);
      await this.ctx.storage.deleteAll(); // left by a job a reset cut short
      await receiveFiles(new Vfs(this.ctx.storage), reader, request, rest);

      // Valkey loads the files as it boots; the rewrite then runs inline, blocking only this object. import-mode:
      // no expiry or eviction, so the base keeps a key that expired after the shard's rewrite started (the shard may
      // have PERSISTed it since), as a forked child would. Named after its shard, so it boots the same server.
      const preamble = request.rdb ? "yes" : "no";

      const host = new ValkeyHost(serverOf(this.ctx.id.name ?? ""), this.ctx.storage, {
        args: [...valkeyArgs(this.env, false), "--aof-use-rdb-preamble", preamble, "--import-mode", "yes"],
        log: (l: string) => logs.push(l),
      });

      const [reply] = decodeAll(await host.execBatch(command(["BGREWRITEAOF"]), 1));

      if (reply instanceof Object && "err" in reply) throw new Error(reply.err);
      const { base } = aofFiles(host);

      if (!base) throw new Error("no base after the rewrite");
      const size = host.fileSize(base) ?? 0;

      // Socket writes wait for this object's storage writes (the files) to be confirmed. Wait here, and below hold
      // the connection until the shard closes it, so nothing still queued is dropped.
      await this.ctx.storage.sync();
      streaming = true;
      await writer.write(line({ size }));
      let sum = FNV0;

      for (let pos = 0; pos < size; pos += VFS_CHUNK) {
        const chunk = host.readFile(base, pos, VFS_CHUNK);

        if (!chunk) throw new Error("the base went away");
        sum = fnv(sum, chunk);
        await writer.write(chunk);
      }

      await writer.write(line({ sum }));

      while (!(await reader.read()).done); // the shard closes once it has checked the base
      await writer.close().catch(() => {});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);

      if (streaming) await writer.abort(e).catch(() => {});
      else
        await writer
          .write(line({ error: [message, ...logs.slice(-4)].join(" | ") }))
          .then(() => writer.close())
          .catch(() => {});
    } finally {
      // Only copies, kept for the job. The job's host goes with this scope.
      await this.ctx.storage.deleteAll().catch((e: Error) => console.log(`rewriter cleanup: ${e.message}`));
      this.#busy = false;
    }
  }
}
