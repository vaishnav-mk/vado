import { concat } from "../../protocol/resp";
import { decoder, encoder } from "../../shared";

// Old shards speak this to new rewriters: request line, files; then size line, base, checksum line back.
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

export const line = (message: RewriteLine): Uint8Array => encoder.encode(JSON.stringify(message) + "\n");

export const FNV0 = 2166136261;

export function fnv(hash: number, bytes: Uint8Array): number {
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);

  return hash >>> 0;
}

// The peer is our own code, of this or an earlier version, so the line is the message its type says.
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

export async function readExactly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  rest: Uint8Array,
  size: number,
  piece: (bytes: Uint8Array) => Promise<void> | void,
): Promise<Uint8Array> {
  let bytes = rest;

  for (let got = 0; got < size;) {
    if (!bytes.length) {
      const next = await reader.read();

      if (next.done) throw new Error(`connection closed after ${got} of ${size} bytes`);
      bytes = next.value;
    }

    const take = bytes.subarray(0, size - got);
    await piece(take);
    got += take.length;
    bytes = bytes.subarray(take.length);
  }

  return bytes;
}
