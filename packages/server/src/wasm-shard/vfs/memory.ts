import type { Memory, Views } from "./types";

// Rebuilt only when the memory grows, which replaces its buffer.
function viewOf<V extends Uint8Array | DataView>(memory: Memory, View: new (buffer: ArrayBuffer) => V): () => V {
  let view: V | null = null;

  return () => {
    const buffer = memory().buffer;

    if (view?.buffer !== buffer) view = new View(buffer);

    return view;
  };
}

export function iovecs(memory: ArrayBufferLike, view: DataView, iovs: number, count: number): Uint8Array[] {
  const out: Uint8Array[] = [];

  for (let i = 0; i < count; i++) {
    out.push(new Uint8Array(memory, view.getUint32(iovs + i * 8, true), view.getUint32(iovs + i * 8 + 4, true)));
  }

  return out;
}

export const viewsOf = (memory: Memory): Views => ({ u8: viewOf(memory, Uint8Array), dv: viewOf(memory, DataView) });
