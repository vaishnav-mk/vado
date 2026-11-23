// Against real Redis in Docker, so opt-in: BOX_IMAGE=vado-redis:8.12.0 npx vitest run packages/server/test/box
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ReplicaLink } from "../../src/box/link";
import { replay } from "../../src/box/redis";
import { BASE, BoxStore, LOG } from "../../src/box/store";
import { roleOffset } from "../../src/box/proxy";
import { command, concat } from "../../src/protocol/resp";
import { RespClient } from "../../src/protocol/resp-client";
import { sleep } from "../../src/shared";
import { fakeStorage } from "../shard/vfs/fake-storage";

const IMAGE = process.env.BOX_IMAGE ?? "";
// Under home: Docker VMs on macOS share it, not /tmp.

const DIR = `${homedir()}/.cache/vado-box-test`;
const ARGS = "--protected-mode no --save '' --appendonly no --repl-diskless-sync yes --repl-diskless-sync-delay 0";

function socket(port: number): Socket {
  const s = connect(port, "127.0.0.1");

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      s.on("data", (d: Buffer) => controller.enqueue(new Uint8Array(d)));
      s.on("end", () => controller.close());
      s.on("error", (e) => controller.error(e));
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write: (chunk) => new Promise((resolve, reject) => s.write(chunk, (e) => (e ? reject(e) : resolve()))),
    close: () => void s.end(),
  });

  const opened = new Promise<SocketInfo>((resolve, reject) => {
    s.once("connect", () => resolve({}));
    s.once("error", reject);
  });

  return {
    readable,
    writable,
    opened,
    closed: new Promise((resolve) => s.once("close", () => resolve())),
    upgraded: false,
    secureTransport: "off",
    close: async () => void s.destroy(),
    startTls: () => {
      throw new Error("no TLS in tests");
    },
  };
}

async function client(port: number): Promise<RespClient> {
  for (;;) {
    try {
      const s = socket(port);

      await s.opened;
      const c = new RespClient(s, 5_000);

      await c.call(["PING"]);

      return c;
    } catch {
      await sleep(200);
    }
  }
}

const docker = (args: string) => execSync(`docker ${args}`, { stdio: "pipe" }).toString().trim();

describe.skipIf(!IMAGE)("replication into storage, then restore", () => {
  const store = new BoxStore(fakeStorage());

  beforeAll(() => {
    mkdirSync(DIR, { recursive: true });
    docker(
      `run -d --rm --name vado-box-a -p 6390:6379 ${IMAGE} sh -c "exec redis-server ${ARGS} --enable-debug-command yes"`,
    );
  });

  afterAll(() => {
    for (const name of ["vado-box-a", "vado-box-b"]) execSync(`docker rm -f ${name}`, { stdio: "ignore" });
  });

  test("stores the RDB and the stream, and ROLE's offset is reached", async () => {
    const a = await client(6390);

    await a.call(["SET", "before", "sync"], ["SADD", "s", "1", "2", "3", "4"]);
    const link = await ReplicaLink.open(socket(6390), store, 1, () => {});

    store.switchTo(link.generation);

    for (let i = 0; i < 2000; i++) await a.send(["SET", `k${i}`, `v${i}`]);
    await a.read(2000);
    await a.call(
      ["INCRBY", "n", "41"],
      ["EXPIRE", "k1", "1000"],
      ["SPOP", "s"],
      ["EVAL", "redis.call('SET', 'lua', redis.call('INCR', 'n')) return 1", "0"],
      ["MULTI"],
      ["HSET", "h", "f", "1"],
      ["LPUSH", "l", "a", "b"],
      ["EXEC"],
    );
    await a.sendRaw(command(["ROLE"]));
    const [role] = await a.read(1, (f) => [f.slice(), 0]);

    await link.reached(roleOffset(role ?? new Uint8Array(0)), 5_000);
    expect(store.bytes(1, BASE)).toBeGreaterThan(0);
    expect(store.bytes(1, LOG)).toBeGreaterThan(2000 * 20);

    // Compaction: a second link takes generation 2 while the first keeps storing, then replaces it.
    const next = await ReplicaLink.open(socket(6390), store, 2, () => {});

    for (let i = 0; i < 500; i++) await a.send(["SET", `late${i}`, `x${i}`]);
    await a.read(500);
    await next.caughtUp(link);
    store.switchTo(next.generation);
    link.handOver(next);
    // WAIT puts a REPLCONF GETACK in the stream: the one frame a replay gets no reply for.
    await a.call(["DEL", "k5"], ["SET", "after", "switch"], ["WAIT", "1", "200"]);
    await a.sendRaw(command(["ROLE"]));
    const [role2] = await a.read(1, (f) => [f.slice(), 0]);

    await next.reached(roleOffset(role2 ?? new Uint8Array(0)), 5_000);
    expect(store.current()?.gen).toBe(2);
    expect(store.bytes(1, LOG)).toBe(0); // generation 1 is gone
    next.close();
  });

  test("a fresh Redis from the current generation alone has the same data", async () => {
    const gen = store.current()?.gen ?? 0;

    writeFileSync(`${DIR}/dump.rdb`, concat([...store.chunks(gen, BASE)]));
    docker(
      `run -d --rm --name vado-box-b -p 6391:6379 -v ${DIR}:/data ${IMAGE} sh -c "exec redis-server ${ARGS} --enable-debug-command yes --dir /data --dbfilename dump.rdb"`,
    );
    await client(6391);
    await replay(socket(6391), store.chunks(gen, LOG));
    const [a, b] = await Promise.all([client(6390), client(6391)]);
    const [digestA, sizeA] = await a.call(["DEBUG", "DIGEST"], ["DBSIZE"]);
    const [digestB, sizeB] = await b.call(["DEBUG", "DIGEST"], ["DBSIZE"]);

    expect(sizeB).toBe(sizeA);
    expect(digestB).toBe(digestA);
  });
});
