import type { ByteSocket, Reply } from "./protocol/types";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const noop = () => {};
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export const failure = (r: Reply): string | null => (r instanceof Object && "err" in r ? r.err : null);

export const percentile = (xs: readonly number[], p: number): number | null =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null;

// The reply, unless it's an error: that is thrown.
export function ok(r: Reply): Reply {
  const err = failure(r);

  if (err !== null) throw new Error(err);

  return r;
}

export function text(r: Reply): string {
  if (r instanceof Object) throw new Error(failure(r) ?? "expected a text reply");

  return String(r);
}

export async function closeWith(socket: Pick<ByteSocket, "writable">, bytes: Uint8Array | null): Promise<void> {
  const writer = socket.writable.getWriter();

  if (bytes) await writer.write(bytes).catch(noop);
  await writer.close().catch(noop);
}

export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms);
  });

  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

// Whether `work` settled within `ms`.
export const within = (work: Promise<void>, ms: number): Promise<boolean> =>
  withTimeout(work, ms, "work").then(
    () => true,
    () => false,
  );
