// Inline, a rewrite blocks the shard (~1.5 s for a 35 MB base). Own classes, so never in a shard's isolate.
import { DurableObject } from "cloudflare:workers";
import { decodeAll } from "../../protocol/decode";
import { command } from "../../protocol/resp";
import { aofFiles, fileChunks, MANIFEST } from "../../replication/aof-files";
import { ValkeyHost } from "../host/valkey-host";
import { wasmOf } from "../servers";
import { valkeyArgs } from "../valkey-args";
import { deployedAt } from "../version";
import { Vfs } from "../vfs/vfs";
import { FNV0, fnv, line, readExactly, readLine } from "./protocol";
import type { RewriteRequest } from "./protocol";
import { closeWith, encoder, messageOf, noop, ok } from "../../shared";

async function receiveFiles(
  vfs: Vfs,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  { manifest, files }: RewriteRequest,
  rest: Uint8Array,
): Promise<void> {
  let bytes = rest;

  for (const [path, size] of files) {
    vfs.append(path, new Uint8Array(0)); // an empty incr file must exist too
    bytes = await readExactly(reader, bytes, size, (piece) => vfs.append(path, piece));
  }

  vfs.append(MANIFEST, encoder.encode(manifest));
  vfs.flush();
}

export class ValkeyRewriter extends DurableObject<Env> {
  #busy = false;

  deployedAt(): number {
    return deployedAt(this.env);
  }

  override async connect(socket: Socket): Promise<void> {
    if (this.#busy) return await closeWith(socket, line({ error: "busy" }));
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();
    this.#busy = true;
    let streaming = false; // after the size line, an error can only cut the base short
    const logs: string[] = [];

    try {
      const [request, rest] = await readLine<RewriteRequest>(reader);
      await this.ctx.storage.deleteAll(); // left by a job a reset cut short
      await receiveFiles(new Vfs(this.ctx.storage), reader, request, rest);

      // import-mode: the base keeps a key that expired after the rewrite started (the shard may have PERSISTed it).
      const preamble = request.rdb ? "yes" : "no";

      const host = new ValkeyHost(wasmOf(this.ctx.id.name ?? ""), this.ctx.storage, {
        args: [...valkeyArgs(this.env, false), "--aof-use-rdb-preamble", preamble, "--import-mode", "yes"],
        log: (l: string) => logs.push(l),
      });

      const [reply = null] = decodeAll(await host.execBatch(command(["BGREWRITEAOF"]), 1));

      ok(reply);
      const { base } = aofFiles(host);

      if (!base) throw new Error("no base after the rewrite");
      const size = host.fileSize(base) ?? 0;

      // Socket writes wait for this object's storage writes; hold the connection until the shard closes it, too.
      await this.ctx.storage.sync();
      streaming = true;
      await writer.write(line({ size }));
      let sum = FNV0;

      for (const chunk of fileChunks(host, base, size)) {
        sum = fnv(sum, chunk);
        await writer.write(chunk);
      }

      await writer.write(line({ sum }));

      while (!(await reader.read()).done);
      await writer.close().catch(noop);
    } catch (e) {
      if (streaming) await writer.abort(e).catch(noop);
      else
        await writer
          .write(line({ error: [messageOf(e), ...logs.slice(-4)].join(" | ") }))
          .then(() => writer.close())
          .catch(noop);
    } finally {
      await this.ctx.storage.deleteAll().catch((e: Error) => console.log(`rewriter cleanup: ${e.message}`));
      this.#busy = false;
    }
  }
}
