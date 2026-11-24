import { noop, withTimeout } from "../shared";
import { LINK_MS } from "./config";
import { StreamLink } from "./link";
import { dial } from "./server";
import { LOG } from "./store";
import type { BoxStore, Generation } from "./store";
import type { Resume, Started } from "./types";

// A reused server must continue the last stored byte (it may hold a cut-short restore); a restored one continues its
// own history.
function resumeOf(store: BoxStore, from: Generation, started: Started): Resume | null {
  if (started.reused) {
    const end = (from.shift ?? from.offset) + store.bytes(from.gen, LOG);

    return { from, replid: from.master ?? from.replid, offset: end, only: true };
  }

  return started.history && { from, ...started.history, only: false };
}

export function linkFor(ctx: DurableObjectState, store: BoxStore, started: Started, onBroken: (why: string) => void) {
  const current = store.current();

  return openLink(ctx, store, store.begin(), current && resumeOf(store, current, started), onBroken);
}

// A sync that outlives its timeout must not keep writing next to the one that replaces it.
export async function openLink(
  ctx: DurableObjectState,
  store: BoxStore,
  gen: number,
  resume: Resume | null,
  onBroken: (why: string) => void,
): Promise<StreamLink> {
  const socket = dial(ctx);

  await socket.opened;

  return await withTimeout(
    StreamLink.open(socket, store, gen, resume, (e) => onBroken(`replication: ${e.message}`)),
    LINK_MS,
    `syncing generation ${gen}`,
  ).catch((e: Error) => {
    socket.close().catch(noop);
    throw e;
  });
}
