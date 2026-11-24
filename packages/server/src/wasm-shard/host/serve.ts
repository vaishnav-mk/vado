import { CLIENT_HIGH_WATER, DRAIN_WAIT_MS, SHARD_HIGH_WATER } from "./config";
import type { Gauge } from "./gauge";
import type { Loop } from "./loop";
import type { Sockets } from "./sockets";
import type { DrainReport, HostSocket, InputSink } from "./types";
import { encoder, noop, within } from "../../shared";
import type { ByteSocket } from "../../protocol/types";

// A quiet socket's leftover input is dropped at its end: old commands must not run after the next copy's FLUSHALL.
export async function serve(
  sockets: Sockets,
  loop: Loop,
  sink: InputSink,
  socket: ByteSocket,
  greeting: string | null,
  quiet: boolean,
  farewell: string | null,
): Promise<void> {
  const writer = socket.writable.getWriter();

  if (greeting) writer.write(encoder.encode(greeting)).catch(noop);
  const s = sockets.add(writer, false);
  loop.updateTimer();
  loop.schedule();
  readInput(sockets, loop, sink, s, socket.readable.getReader(), quiet).catch(() => {
    s.eof = true;
    loop.schedule();
  });
  await s.closed.promise;

  if (sockets.draining && farewell) await writer.write(encoder.encode(farewell)).catch(noop);
  await writer.close().catch(noop);
  s.finished.resolve();
}

async function readInput(
  sockets: Sockets,
  loop: Loop,
  sink: InputSink,
  s: HostSocket,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  quiet: boolean,
): Promise<void> {
  for (;;) {
    while (!s.eof && !sockets.draining && (s.inflight > CLIENT_HIGH_WATER || sockets.total > SHARD_HIGH_WATER)) {
      await sockets.paused(s);
    }

    // From drain() on, only drain() ends the client: an end here could free it in Valkey with replies unsent.
    if (sockets.draining) return;
    const { value, done } = await reader.read();

    if (sockets.draining) return;

    if (done) break;
    s.chunks.push(value);

    if (!quiet) {
      sink.lastActive = Date.now();
      sink.onInput?.();
    }

    loop.schedule();
  }

  if (quiet) {
    s.chunks = [];
    s.off = 0;
  }

  s.eof = true;
  loop.schedule();
}

// Afterwards a command a client got no reply to never ran, and every reply's write is committed.
export async function drain(
  sockets: Sockets,
  loop: Loop,
  batches: Gauge,
  sync: (() => Promise<void>) | undefined,
): Promise<DrainReport> {
  sockets.draining = true;
  const clients = sockets.clients();

  for (const s of clients) {
    s.chunks = [];
    s.off = 0;
    s.wake?.();
  }

  sockets.wakeAll();

  // A running batch could unblock a client's BLPOP while it closes, popping an element with no reply.
  await within(batches.zero(), DRAIN_WAIT_MS);

  // The host never refuses a write, so a pass that writes nothing leaves no reply unsent.
  for (let i = 0, writes = -1; i < 1000 && writes !== sockets.writes; i++) {
    writes = sockets.writes;
    loop.step();
  }

  await loop.commits.zero();
  await sync?.();

  for (const s of clients) s.eof = true;

  for (let i = 0; i < 4; i++) loop.step();
  const finished = Promise.all(clients.map((s) => s.finished.promise)).then(noop);

  return { clients: clients.length, closed: await within(finished, DRAIN_WAIT_MS) };
}
