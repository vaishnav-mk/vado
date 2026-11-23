import type { Server } from "../catalog/types";
import { decoder, messageOf, noop, sleep, withTimeout } from "../shared";
import { containerOf, dial, historyOf, ready, replay } from "./server";
import { BASE, LOG } from "./store";
import type { BoxStore } from "./store";

const COPY_PORT = 7000;
const STALL_MS = 15_000;

// A running server answers at once; one that doesn't (an object died mid-restore) is replaced.
const REUSE_MS = 10_000;

// A burst of new shards can outrun the instances the platform has ready; it provisions more within a minute or two.
const CAPACITY_MS = 180_000;

// Some fresh containers drop or stall the copy, or exit on a cut one; another container takes it.
const COPIES = 3;

const COPY_FAILED = "copying the stored RDB in";

const EXITED = "the container exited while starting";

// No persistence of its own: the shard's object is its only durable copy, through replication. No keepalive PINGs in
// the stream (the link's ACKs show it is alive), so an idle server's stream stays empty and a restore can continue it.
const serverArgs = (maxmemory: string) =>
  [
    "--protected-mode no",
    '--save ""',
    "--appendonly no",
    `--maxmemory ${maxmemory}`,
    "--maxmemory-policy noeviction",
    "--repl-diskless-sync yes",
    "--repl-diskless-sync-delay 0",
    "--repl-ping-replica-period 3600",
    "--repl-backlog-size 64mb",
    "--dir /data",
    "--dbfilename dump.rdb",
  ].join(" ");

// With a stored copy, the container takes it on COPY_PORT before the server starts and loads it.
const entrypoint = (server: Server, maxmemory: string, copy: boolean) => [
  "sh",
  "-c",
  `${copy ? `nc -d -l ${COPY_PORT} > /data/dump.rdb && ` : ""}exec ${server}-server ${serverArgs(maxmemory)}`,
];

export interface Started {
  exited: Promise<void>; // settles when the container stops
  reused: boolean; // it was already running: the same server, with its memory
  history: { replid: string; offset: number } | null; // a restored server's own, after the stored copy
  restored: { baseMB: number; logMB: number; copyMs: number; loadMs: number; replayMs: number } | null;
}

const mb = (bytes: number) => Math.round(bytes / 1e5) / 10;

// A container that fails to start, or exits on the way, fails the boot at once instead of at READY_MS.
export async function startServer(
  ctx: DurableObjectState,
  store: BoxStore,
  server: Server,
  maxmemory: string,
): Promise<Started> {
  const container = containerOf(ctx);

  // Trusted only if its server continues the stored stream (engine.ts): a restore cut short can't.
  if (container.running) {
    if (
      await ready(ctx, REUSE_MS).then(
        () => true,
        () => false,
      )
    )
      return { exited: container.monitor(), reused: true, history: null, restored: null };
    await replace(ctx, "not answering");
  }

  const image = container.images[server];

  if (!image) throw new Error(`this build has no ${server} image (VADO_CONTAINERS=1)`);

  for (let copies = 0, deadline = Date.now() + CAPACITY_MS; ;) {
    const copy = store.current() !== null;

    container.start({
      image,
      instance: "standard-1",
      enableInternet: false,
      entrypoint: entrypoint(server, maxmemory, copy),
    });
    const exited = container.monitor();
    const failed = exited.then(() => Promise.reject(new Error(EXITED)));

    failed.catch(noop);

    try {
      return { exited, reused: false, ...(await Promise.race([restore(ctx, container, store), failed])) };
    } catch (e) {
      const why = messageOf(e);
      const capacity = why.includes("no container instance") && Date.now() < deadline;
      const again = (why.startsWith(COPY_FAILED) || why === EXITED) && copy && ++copies < COPIES;

      if (!capacity && !again) throw e;
      console.log(`starting again: ${why}`);

      if (again) await replace(ctx, "copy failed");
      else await sleep(2_000);
    }
  }
}

async function restore(
  ctx: DurableObjectState,
  container: Container,
  store: BoxStore,
): Promise<Pick<Started, "history" | "restored">> {
  const current = store.current();

  if (!current) {
    await ready(ctx);

    return { history: null, restored: null };
  }

  const t0 = Date.now();

  await copyIn(ctx, container, store.chunks(current.gen, BASE)).catch((e: Error) => {
    throw new Error(`${COPY_FAILED}: ${e.message}`);
  });
  const t1 = Date.now();

  await ready(ctx);
  const t2 = Date.now();

  if (store.bytes(current.gen, LOG)) await replay(dial(ctx), store.chunks(current.gen, LOG));

  return {
    history: await historyOf(ctx),
    restored: {
      baseMB: mb(store.bytes(current.gen, BASE)),
      logMB: mb(store.bytes(current.gen, LOG)),
      copyMs: t1 - t0,
      loadMs: t2 - t1,
      replayMs: Date.now() - t2,
    },
  };
}

// Destroyed and gone, so the next start() gets a fresh container.
export async function replace(ctx: DurableObjectState, why: string): Promise<void> {
  const container = containerOf(ctx);

  if (!container.running) return;
  const exited = container.monitor();

  await container.destroy(why).catch(noop);
  await withTimeout(exited, 30_000, "the container to stop").catch(noop);
}

async function run(container: Container, cmd: string[], ms = 30_000): Promise<void> {
  const { exitCode, stderr } = await withTimeout(
    container.exec(cmd, { stdout: "ignore" }).then((p) => p.output()),
    ms,
    cmd.join(" "),
  );

  if (exitCode !== 0) throw new Error(`${cmd.join(" ")}: exit ${exitCode}: ${decoder.decode(stderr)}`);
}

// Over TCP, several times faster than exec() stdin. A cut copy fails the server's RDB checksum, and the container
// exits.
async function copyIn(ctx: DurableObjectState, container: Container, chunks: Iterable<Uint8Array>): Promise<void> {
  // COPY_PORT (0x1B58) in LISTEN state (0A) first: a copy sent before that measured as never arriving.
  await run(container, ["sh", "-c", "until grep -q ':1B58 00000000:0000 0A' /proc/net/tcp; do sleep 0.01; done"]);
  const socket = containerOf(ctx).getTcpPort(COPY_PORT).connect(`10.0.0.1:${COPY_PORT}`);

  try {
    await withTimeout(socket.opened, STALL_MS, "connecting");
    const writer = socket.writable.getWriter();

    for (const chunk of chunks) await withTimeout(writer.write(chunk), STALL_MS, "sending");
    await withTimeout(writer.close(), STALL_MS, "closing");
  } catch (e) {
    socket.close().catch(noop);
    throw e;
  }
}
