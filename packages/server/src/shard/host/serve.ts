import { CLIENT_HIGH_WATER, SHARD_HIGH_WATER } from "./config";
import { type Gauge, within } from "./gauge";
import type { Loop } from "./loop";
import type { Sockets } from "./sockets";
import type { ByteSocket, DrainReport, HostSocket, InputSink } from "./types";

const encoder = new TextEncoder();

/**
 * One TCP client as one Valkey client fd; resolves when Valkey closes the fd. A quiet socket (a replica's stream
 * from its primary) isn't client activity, and what it hasn't run when it ends is dropped: the primary copies the
 * replica afresh, and old commands must not run after that copy's FLUSHALL. `farewell` is written last if drain()
 * closes the socket: it tells the client that nothing it got no reply to ran.
 */
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

  if (greeting) writer.write(encoder.encode(greeting)).catch(() => {});
  const s = sockets.add(writer, false);
  loop.updateTimer();
  loop.schedule();
  readInput(sockets, loop, sink, s, socket.readable.getReader(), quiet).catch(() => {
    s.eof = true;
    loop.schedule();
  });
  await s.closed.promise;

  if (sockets.draining && farewell) await writer.write(encoder.encode(farewell)).catch(() => {});
  await writer.close().catch(() => {});
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
    // Backpressure: a client that isn't reading its replies stops being read.
    while (!s.eof && !sockets.draining && (s.inflight > CLIENT_HIGH_WATER || sockets.total > SHARD_HIGH_WATER)) {
      await sockets.paused(s);
    }

    // From drain() on, input is dropped and only drain() ends the client: an end here could free it in Valkey
    // with replies still unsent.
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

/**
 * Stops client input, answers everything Valkey has read, then closes every client socket (each after its
 * farewell). Afterwards a command a client got no reply to never ran, and every reply's write is committed. Input
 * received but not yet read by Valkey is dropped, so this is quick. Internal clients (RPC batches) finish.
 */
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

  // RPC batches already running finish first (the shard refuses new ones): one could unblock a client's BLPOP
  // while that client is being closed, and the element would be popped with no reply.
  await within(batches.zero(), 5000);

  // Valkey writes a reply in the pass after the command, big ones over several passes, and the host never refuses
  // a write: a pass that writes nothing leaves no reply unsent.
  for (let i = 0, writes = -1; i < 1000 && writes !== sockets.writes; i++) {
    writes = sockets.writes;
    loop.step();
  }

  await loop.commits.zero();
  await sync?.();

  for (const s of clients) s.eof = true; // Valkey frees each client, with nothing left to send

  for (let i = 0; i < 4; i++) loop.step();
  const finished = Promise.all(clients.map((s) => s.finished.promise)).then(() => {});

  return { clients: clients.length, closed: await within(finished, 5000) };
}
