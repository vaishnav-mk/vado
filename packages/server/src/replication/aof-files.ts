import type { AofEntry, AofFiles, ReplicatorHost } from "./types";

export const MANIFEST = "aof/appendonly.aof.manifest";

/** The AOF files as of now, from the manifest: the base, the incr files in order, and every entry with its line. */
export function aofFiles(host: Pick<ReplicatorHost, "fileSize" | "readFile">): AofFiles {
  const size = host.fileSize(MANIFEST);
  const bytes = size === null ? null : host.readFile(MANIFEST, 0, size);

  if (bytes === null) throw new Error("no AOF manifest yet");
  const entries: AofEntry[] = [];
  const incrs = [];

  for (const line of new TextDecoder().decode(bytes).split("\n")) {
    if (!line.startsWith("file ")) continue;
    const words = line.trim().split(/\s+/);
    const entry = { path: `aof/${words[1]}`, type: words[words.indexOf("type") + 1], line };
    entries.push(entry);

    if (entry.type === "i") incrs.push(entry.path);
  }

  return { base: entries.find((e) => e.type === "b")?.path, incrs, entries };
}
