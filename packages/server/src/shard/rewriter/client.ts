import { aofFiles } from "../../replication/aof-files";
import type { ValkeyHost } from "../host/valkey-host";
import { AOF_HELPER_TIMEOUT_MS } from "../config";
import type { RewriteLog } from "../types";
import { VFS_CHUNK } from "../vfs/config";
import { FNV0, fnv, line, readLine } from "./protocol";
import type { RewriteHead, RewriteTail } from "./protocol";

const yieldTurn = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Shard side: writes the base for the rewrite Valkey just started to `tmp` (RDB if `rdb`), via a rewriter's stub.
 *  `sync` resolves once storage has every write so far. Phase times and sizes go in `log`. */
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
      for (let pos = 0; pos < size; pos += VFS_CHUNK) {
        await writer.write(host.readFile(path, pos, VFS_CHUNK));
        await yieldTurn();
      }

    log.sentMs = Date.now() - t0;
    log.sentBytes = files.reduce((n, [, size]) => n + size, 0);
    const [head, rest] = await readLine<RewriteHead>(reader);
    log.headMs = Date.now() - t0;

    if (head.error !== undefined) throw new Error(`rewriter: ${head.error}`);
    log.baseBytes = head.size;
    host.removeFile(tmp); // one left by a rewrite that a restart cut short
    host.appendFile(tmp, new Uint8Array(0)); // the file must exist even when the base is empty

    // Every reply waits for the storage writes before it, so take the base one chunk's commit at a time: a reply
    // then waits for at most one chunk, not for all of the base that arrived ahead of it.
    let got = 0;
    let synced = 0;
    let sum = FNV0;
    let bytes = rest;

    for (;;) {
      if (bytes.length) {
        const take = bytes.subarray(0, head.size - got);
        host.appendFile(tmp, take);
        sum = fnv(sum, take);
        got += take.length;
        bytes = bytes.subarray(take.length);

        if (got - synced >= VFS_CHUNK) {
          await sync();
          synced = got;
        }
      }

      if (got >= head.size) break;
      const next = await reader.read();

      if (next.done) break;
      bytes = next.value;
    }

    if (got !== head.size) throw new Error(`base cut short: ${got} of ${head.size} bytes`);
    log.receivedMs = Date.now() - t0;
    const [tail] = await readLine<RewriteTail>(reader, bytes);
    log.tailMs = Date.now() - t0;

    if (tail.sum !== sum) throw new Error("base checksum mismatch");

    return true;
  } finally {
    clearTimeout(timer);
    void socket.close();
  }
}
