import { elements, EMPTY, frameEnd, lower } from "../protocol/resp";
import { RespClient } from "../protocol/resp-client";
import { append } from "../router/buffer";
import { decoder, failure, messageOf, noop, sleep, withTimeout } from "../shared";
import { BASE, LOG } from "./store";
import type { BoxStore } from "./store";

const PORT = 6379;
const COPY_PORT = 7000;
const COPY_FAILED = "copying the stored RDB in";
const STALL_MS = 15_000;
const READY_MS = 300_000;
// A burst of new shards can outrun the instances the platform has ready; it provisions more within a minute or two.

const CAPACITY_MS = 180_000;
const GATE = "/data/go";
const RESTORED = "/data/restored";

// No persistence of its own: this object is its only durable copy, through replication.
const redisArgs = (maxmemory: string) =>
  [
    "--protected-mode no",
    '--save ""',
    "--appendonly no",
    `--maxmemory ${maxmemory}`,
    "--maxmemory-policy noeviction",
    "--repl-diskless-sync yes",
    "--repl-diskless-sync-delay 0",
    "--dir /data",
    "--dbfilename dump.rdb",
  ].join(" ");

export function containerOf(ctx: DurableObjectState): Container {
  if (!ctx.container) throw new Error("this object has no container");

  return ctx.container;
}

function imageOf(container: Container): string {
  const image = container.images.redis;

  if (!image) throw new Error("this build has no redis image (VADO_CONTAINERS=1)");

  return image;
}

export const dial = (ctx: DurableObjectState): Socket => containerOf(ctx).getTcpPort(PORT).connect(`10.0.0.1:${PORT}`);

export interface Started {
  exited: Promise<void>; // settles when the container stops
  restored: { baseMB: number; logMB: number; baseMs: number; readyMs: number; replayMs: number } | null;
}

const mb = (bytes: number) => Math.round(bytes / 1e5) / 10;

// A fresh container waits behind GATE until the stored copy is on its disk, then loads it as Redis boots. A container
// that fails to start, or exits on the way, fails the boot at once instead of at READY_MS.
export async function startRedis(ctx: DurableObjectState, store: BoxStore, maxmemory: string): Promise<Started> {
  const container = containerOf(ctx);

  if (container.running) {
    // Syncing from a container whose restore died part way would store its partial copy as the next generation.
    await run(container, ["test", "-e", RESTORED]).catch(() => {
      throw new Error("the running container never finished its restore");
    });
    await ready(ctx);

    return { exited: container.monitor(), restored: null };
  }

  for (let copies = 0, deadline = Date.now() + CAPACITY_MS; ;) {
    container.start({
      image: imageOf(container),
      instance: "standard-1",
      enableInternet: false,
      entrypoint: [
        "sh",
        "-c",
        `while [ ! -e ${GATE} ]; do sleep 0.05; done; exec redis-server ${redisArgs(maxmemory)}`,
      ],
    });
    const exited = container.monitor();
    const failed = exited.then(() => Promise.reject(new Error("the container exited while starting")));

    failed.catch(noop);

    try {
      return { exited, restored: await Promise.race([restore(ctx, container, store), failed]) };
    } catch (e) {
      const capacity = messageOf(e).includes("no container instance") && Date.now() < deadline;
      // Some fresh containers drop or stall the copy; another one takes it.
      const copy = messageOf(e).startsWith(COPY_FAILED) && ++copies < 3;

      if (!capacity && !copy) throw e;
      console.log(`starting again: ${messageOf(e)}`);

      if (copy) {
        await container.destroy("copy failed").catch(noop);
        await withTimeout(exited, 30_000, "the container to stop").catch(noop);
      } else await sleep(2_000);
    }
  }
}

async function restore(ctx: DurableObjectState, container: Container, store: BoxStore): Promise<Started["restored"]> {
  const current = store.current();
  const t0 = Date.now();

  if (current)
    await copyIn(ctx, container, store.chunks(current.gen, BASE), store.bytes(current.gen, BASE)).catch((e: Error) => {
      throw new Error(`${COPY_FAILED}: ${e.message}`);
    });
  const t1 = Date.now();

  await run(container, ["touch", GATE]);
  await ready(ctx);
  const t2 = Date.now();

  if (current) await replay(dial(ctx), store.chunks(current.gen, LOG));
  await run(container, ["touch", RESTORED]);

  return current
    ? {
        baseMB: mb(store.bytes(current.gen, BASE)),
        logMB: mb(store.bytes(current.gen, LOG)),
        baseMs: t1 - t0,
        readyMs: t2 - t1,
        replayMs: Date.now() - t2,
      }
    : null;
}

async function run(container: Container, cmd: string[], ms = 30_000): Promise<void> {
  const { exitCode, stderr } = await withTimeout(
    container.exec(cmd, { stdout: "ignore" }).then((p) => p.output()),
    ms,
    cmd.join(" "),
  );

  if (exitCode !== 0) throw new Error(`${cmd.join(" ")}: exit ${exitCode}: ${decoder.decode(stderr)}`);
}

// Over TCP to netcat in the container, several times faster than exec() stdin. netcat exits 0 on any close, so the
// size check is what tells a whole copy from a cut one.
async function copyIn(
  ctx: DurableObjectState,
  container: Container,
  chunks: Iterable<Uint8Array>,
  bytes: number,
): Promise<void> {
  const received = run(container, ["sh", "-c", `nc -d -l ${COPY_PORT} > /data/dump.rdb`], 60_000 + bytes / 2_000);

  received.catch(noop);
  // Port 7000 in LISTEN state (0A): a connect() before that might be accepted by the platform and go nowhere.
  await run(container, ["sh", "-c", "until grep -q ':1B58 00000000:0000 0A' /proc/net/tcp; do sleep 0.02; done"]);
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

  await withTimeout(received, STALL_MS, "netcat to finish");
  await run(container, ["sh", "-c", `[ "$(stat -c %s /data/dump.rdb)" = "${bytes}" ]`]);
}

async function ready(ctx: DurableObjectState): Promise<void> {
  const deadline = Date.now() + READY_MS;

  for (;;) {
    try {
      const socket = dial(ctx);

      await withTimeout(socket.opened, 5_000, "connecting");
      const client = new RespClient(socket, 5_000);
      const [pong = null] = await client.call(["PING"]);

      client.close();

      if (failure(pong) === null) return; // LOADING until the RDB is in
    } catch {
      // not listening yet
    }

    if (Date.now() > deadline) throw new Error(`Redis wasn't ready after ${READY_MS / 1000} s`);
    await sleep(250);
  }
}

// The stored stream is Redis's own effects (SELECT, writes, PEXPIREAT, MULTI/EXEC), so it replays as plain commands.
// Every frame gets a reply nobody reads, except REPLCONF GETACK (sent after a WAIT), which a plain client gets none for.
const isReplconf = (frame: Uint8Array) => {
  const [first = EMPTY] = elements(frame);

  return lower(first) === "$8\r\nreplconf\r\n";
};

export async function replay(socket: Socket, chunks: Iterable<Uint8Array>): Promise<void> {
  await socket.opened;
  const client = new RespClient(socket, 60_000);

  let carry: Uint8Array = new Uint8Array(0),
    sent = 0;

  for (const chunk of chunks) {
    carry = append(carry, chunk);
    let start = 0;

    for (let e; (e = frameEnd(carry, start, carry.length)) >= 0; start = e)
      if (!isReplconf(carry.subarray(start, e))) sent++;
    await client.sendRaw(chunk);
    carry = carry.slice(start);
  }

  await client.read(sent, () => [0, 0]);
  client.close();
}
