import { aofFiles, fileChunks } from "../../replication/aof-files";
import type { ValkeyHost } from "../host/valkey-host";
import { AOF_HELPER_TIMEOUT_MS } from "../config";
import type { RewriteLog } from "../types";
import { VFS_CHUNK } from "../vfs/config";
import { FNV0, fnv, line, readExactly, readLine } from "./protocol";
import type { RewriteHead, RewriteTail } from "./protocol";
import { sleep } from "../../shared";

export async function rewriteByHelper(
  host: ValkeyHost,
  stub: Pick<DurableObjectStub, "connect">,
  tmp: string,
  rdb: boolean,
  sync: () => Promise<void>,
  log: RewriteLog,
): Promise<true> {
  const t0 = Date.now();

  const { entries } = aofFiles(host);
  const newIncr = entries.findLast((e) => e.type === "i"); // the one Valkey just opened for the rewrite
  const before = entries.filter((e) => e.type === "b" || (e.type === "i" && e !== newIncr));
  const files = before.map((e): [string, number] => [e.path, host.fileSize(e.path) ?? 0]);
  const socket = stub.connect("rewrite:6379");
  const timer = setTimeout(() => socket.close(), AOF_HELPER_TIMEOUT_MS);

  try {
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();

    await writer.write(line({ manifest: before.map((e) => e.line).join("\n") + "\n", files, rdb }));

    // Reading the files is synchronous SQLite work: yield between chunks so requests keep running.
    for (const [path, size] of files)
      for (const chunk of fileChunks(host, path, size)) {
        await writer.write(chunk);
        await sleep(0);
      }

    log.sentMs = Date.now() - t0;
    log.sentBytes = files.reduce((n, [, size]) => n + size, 0);
    const [head, rest] = await readLine<RewriteHead>(reader);
    log.headMs = Date.now() - t0;

    if (head.error !== undefined) throw new Error(`rewriter: ${head.error}`);
    log.baseBytes = head.size;
    host.removeFile(tmp); // one left by a rewrite that a restart cut short
    host.appendFile(tmp, new Uint8Array(0)); // the file must exist even when the base is empty
    let got = 0;
    let synced = 0;
    let sum = FNV0;

    // Every reply waits for the storage writes before it, so commit a chunk at a time, not the whole base at once.
    const after = await readExactly(reader, rest, head.size, async (piece) => {
      host.appendFile(tmp, piece);
      sum = fnv(sum, piece);
      got += piece.length;

      if (got - synced >= VFS_CHUNK) {
        await sync();
        synced = got;
      }
    });

    log.receivedMs = Date.now() - t0;
    const [tail] = await readLine<RewriteTail>(reader, after);
    log.tailMs = Date.now() - t0;

    if (tail.sum !== sum) throw new Error("base checksum mismatch");

    return true;
  } finally {
    clearTimeout(timer);
    void socket.close();
  }
}
