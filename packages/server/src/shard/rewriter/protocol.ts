// The rewriter's socket protocol, which old shards speak to new rewriters: the shard sends a JSON line (the request),
// then the files; the rewriter answers with a JSON line (the base's size, or an error), the base, and a JSON line with
// its checksum.
import { concat } from "../../protocol/resp";

export interface RewriteRequest {
  manifest: string;
  files: [path: string, size: number][];
  rdb: boolean;
}

export type RewriteHead = { size: number; error?: undefined } | { error: string };

export interface RewriteTail {
  sum: number;
}

export type RewriteLine = RewriteRequest | RewriteHead | RewriteTail;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const line = (message: RewriteLine): Uint8Array => encoder.encode(JSON.stringify(message) + "\n");

// FNV-1a of the base, sent after it: the shard installs only a base that arrived exactly as it was sent.
export const FNV0 = 2166136261;

export function fnv(hash: number, bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);

  return hash >>> 0;
}

/** A JSON line (after the bytes already in `acc`), and whatever arrived after it. The peer is our own code, of
 *  this or an earlier version, so the line is the message its type says. */
export async function readLine<T extends RewriteLine>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  acc: Uint8Array = new Uint8Array(0),
): Promise<[T, Uint8Array]> {
  for (;;) {
    const i = acc.indexOf(10);

    if (i >= 0) return [JSON.parse(decoder.decode(acc.subarray(0, i))), acc.subarray(i + 1)];

    if (acc.length > 1 << 20) throw new Error("header too long");
    const { value, done } = await reader.read();

    if (done) throw new Error("connection closed");
    acc = concat([acc, value]);
  }
}
