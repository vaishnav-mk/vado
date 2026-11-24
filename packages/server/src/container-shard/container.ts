import type { Server } from "../catalog/types";
import { decoder, messageOf, noop, sleep, withTimeout } from "../shared";
import {
  CAPACITY_MS,
  CAPACITY_RETRY_MS,
  COPIES,
  LISTEN_MS,
  REPL_BACKLOG,
  REPLICA_BUFFER,
  REUSE_MS,
  STALL_MS,
  STOP_MS,
} from "./config";
import { containerOf, dial, historyOf, ready, replay } from "./server";
import { BASE, LOG } from "./store";
import type { BoxStore } from "./store";
import type { Started } from "./types";

// A restore sends the stored RDB here before the server starts; /proc/net/tcp shows the port in hex.
const COPY_PORT = 7000;
const COPY_LISTENING = `:${COPY_PORT.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A`;

const COPY_FAILED = "copying the stored RDB in";
const EXITED = "the container exited while starting";

const serverArgs = (maxmemory: string) =>
  [
    "--protected-mode no",
    '--save ""', // the object's storage is the only copy
    "--appendonly no",
    `--maxmemory ${maxmemory}`,
    "--maxmemory-policy noeviction",
    "--repl-diskless-sync yes",
    "--repl-diskless-sync-delay 0",
    "--repl-ping-replica-period 3600", // no keepalives: an idle stream stays empty, so a restore can continue it
    `--repl-backlog-size ${REPL_BACKLOG}`,
    `--client-output-buffer-limit "replica ${REPLICA_BUFFER} 0 0"`,
    "--dir /data",
    "--dbfilename dump.rdb",
  ].join(" ");

const entrypoint = (server: Server, maxmemory: string, copy: boolean) => [
  "sh",
  "-c",
  `${copy ? `nc -d -l ${COPY_PORT} > /data/dump.rdb && ` : ""}exec ${server}-server ${serverArgs(maxmemory)}`,
];

const mb = (bytes: number) => Math.round(bytes / 1e5) / 10;

export async function startServer(
  ctx: DurableObjectState,
  store: BoxStore,
  server: Server,
  maxmemory: string,
): Promise<Started> {
  const container = containerOf(ctx);

  if (container.running) {
    const answers = await ready(ctx, REUSE_MS).then(
      () => true,
      () => false,
    );

    if (answers) return { exited: container.monitor(), reused: true, history: null, restored: null };
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
    const failed = exited.then(() => Promise.reject(new Error(EXITED))); // fails the boot at once, not at READY_MS

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
      else await sleep(CAPACITY_RETRY_MS);
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
  await withTimeout(exited, STOP_MS, "the container to stop").catch(noop);
}

// TCP, not exec() stdin; a cut copy fails the RDB checksum and the container exits.
async function copyIn(ctx: DurableObjectState, container: Container, chunks: Iterable<Uint8Array>): Promise<void> {
  // A copy sent before the port listens never arrives.
  const wait = ["sh", "-c", `until grep -q '${COPY_LISTENING}' /proc/net/tcp; do sleep 0.01; done`];

  const { exitCode, stderr } = await withTimeout(
    container.exec(wait, { stdout: "ignore" }).then((p) => p.output()),
    LISTEN_MS,
    "the copy port to listen",
  );

  if (exitCode !== 0) throw new Error(`waiting for the copy port: exit ${exitCode}: ${decoder.decode(stderr)}`);
  const socket = dial(ctx, COPY_PORT);

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
