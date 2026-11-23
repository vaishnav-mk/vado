import type { Reply } from "./protocol/types";

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const noop = () => {};
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export const failure = (r: Reply): string | null => (r instanceof Object && "err" in r ? r.err : null);

export async function closeWith(socket: Socket, bytes: Uint8Array | null): Promise<void> {
  const writer = socket.writable.getWriter();

  if (bytes) await writer.write(bytes).catch(noop);
  await writer.close().catch(noop);
}
