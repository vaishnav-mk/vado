import { VFS_CHUNK } from "./vfs/config";
import { decoder } from "../shared";
import type { WasmHost } from "./host/wasm-host";
import type { AofEntry, AofFiles } from "./types";

export const MANIFEST = "aof/appendonly.aof.manifest";

export function aofFiles(host: Pick<WasmHost, "fileSize" | "readFile">): AofFiles {
  const size = host.fileSize(MANIFEST);
  const bytes = size === null ? null : host.readFile(MANIFEST, 0, size);

  if (bytes === null) throw new Error("no AOF manifest yet");
  const entries: AofEntry[] = [];
  const incrs = [];

  for (const line of decoder.decode(bytes).split("\n")) {
    if (!line.startsWith("file ")) continue;
    const words = line.trim().split(/\s+/);
    const entry = { path: `aof/${words[1]}`, type: words[words.indexOf("type") + 1], line };
    entries.push(entry);

    if (entry.type === "i") incrs.push(entry.path);
  }

  return { base: entries.find((e) => e.type === "b")?.path, incrs, entries };
}

// Never past `size`: bytes appended since then reach the reader another way, and would run twice.
export function* fileChunks(host: Pick<WasmHost, "readFile">, path: string, size: number): Generator<Uint8Array> {
  for (let pos = 0; pos < size; pos += VFS_CHUNK) {
    const bytes = host.readFile(path, pos, Math.min(VFS_CHUNK, size - pos));

    if (!bytes) throw new Error(`${path} is gone`);

    yield bytes;
  }
}
