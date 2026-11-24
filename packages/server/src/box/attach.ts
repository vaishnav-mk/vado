import { noop, withTimeout } from "../shared";
import type { Started } from "./container";
import { ReplicaLink } from "./link";
import type { Resume } from "./link";
import { dial } from "./server";
import { LOG } from "./store";
import type { BoxStore, Generation } from "./store";

// Attaching this object to the container's server as its replica: where the stored stream can go on, and the link.

export const LINK_MS = 300_000;

// A server that kept running must go on from the last stored byte, or it may hold a restore cut short. A restored one
// holds exactly what's stored, so it goes on from its own history. The server checks its history, so a wrong guess
// costs a full copy, never a gap.
function resumeOf(store: BoxStore, from: Generation, started: Started): Resume | null {
  if (started.reused) {
    const end = (from.shift ?? from.offset) + store.bytes(from.gen, LOG);

    return { from, replid: from.master ?? from.replid, offset: end, only: true };
  }

  return started.history && { from, ...started.history, only: false };
}

export const linkFor = (
  ctx: DurableObjectState,
  store: BoxStore,
  started: Started,
  onBroken: (why: string) => void,
) => {
  const current = store.current();

  return openLink(ctx, store, store.begin(), current && resumeOf(store, current, started), onBroken);
};

// A sync that outlives its timeout must not keep writing next to the one that replaces it.
export async function openLink(
  ctx: DurableObjectState,
  store: BoxStore,
  gen: number,
  resume: Resume | null,
  onBroken: (why: string) => void,
): Promise<ReplicaLink> {
  const socket = dial(ctx);

  await socket.opened;

  return await withTimeout(
    ReplicaLink.open(socket, store, gen, resume, (e) => onBroken(`replication: ${e.message}`)),
    LINK_MS,
    `syncing generation ${gen}`,
  ).catch((e: Error) => {
    socket.close().catch(noop);
    throw e;
  });
}
