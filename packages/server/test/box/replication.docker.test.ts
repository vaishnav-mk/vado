// Against a real server in Docker, so opt-in (packages/box/README.md):
//   BOX_IMAGE=vado-valkey BOX_SERVER=valkey npx vitest run packages/server/test/box
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CANT_CONTINUE, StreamLink } from "../../src/box/link";
import { replay } from "../../src/box/server";
import { BASE, BoxStore, LOG } from "../../src/box/store";
import { roleOffset } from "../../src/box/proxy";
import { command, concat } from "../../src/protocol/resp";
import { RespClient } from "../../src/protocol/resp-client";
import { infoFields } from "../../src/shard/info";
import { sleep, text } from "../../src/shared";
import { fakeStorage } from "../shard/vfs/fake-storage";
import { socket } from "./node-socket";

const IMAGE = process.env.BOX_IMAGE ?? "";

const SERVER = process.env.BOX_SERVER ?? "valkey";

// Under home: Docker VMs on macOS share it, not /tmp.
const DIR = `${homedir()}/.cache/vado-box-test`;

// As container.ts runs it, plus DEBUG DIGEST.
const ARGS = [
  "--protected-mode no --save '' --appendonly no --repl-diskless-sync yes --repl-diskless-sync-delay 0",
  "--repl-ping-replica-period 3600 --repl-backlog-size 64mb --enable-debug-command yes",
].join(" ");

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

const NAMES = ["vado-box-a", "vado-box-b", "vado-box-c", "vado-box-d", "vado-box-e"];

// A server on `port`, loading `rdb` first when given.
function serve(name: string, port: number, rdb?: Uint8Array): void {
  const dir = `${DIR}/${name}`;
  const load = rdb ? "--dir /data --dbfilename dump.rdb" : "";

  mkdirSync(dir, { recursive: true });

  if (rdb) writeFileSync(`${dir}/dump.rdb`, rdb);
  docker(
    `run -d --rm --name ${name} -p ${port}:6379 -v ${dir}:/data ${IMAGE} sh -c "exec ${SERVER}-server ${ARGS} ${load}"`,
  );
}

async function role(c: RespClient): Promise<number> {
  await c.sendRaw(command(["ROLE"]));
  const [reply] = await c.read(1, (f) => [f.slice(), 0]);

  return roleOffset(reply ?? new Uint8Array(0));
}

const digest = async (port: number) => (await client(port)).call(["DEBUG", "DIGEST"], ["DBSIZE"]);

describe.skipIf(!IMAGE)(`${SERVER}: replication into storage, then restore`, () => {
  const store = new BoxStore(fakeStorage());

  const current = () => {
    const g = store.current();

    if (!g) throw new Error("no generation");

    return g;
  };

  // A server built from storage alone: the base, then the stream replayed.
  async function restored(name: string, port: number): Promise<void> {
    const g = current();

    serve(name, port, concat([...store.chunks(g.gen, BASE)]));
    await client(port);
    await replay(socket(port), store.chunks(g.gen, LOG));
  }

  beforeAll(() => serve("vado-box-a", 16390));

  afterAll(() => {
    for (const name of NAMES) execSync(`docker rm -f ${name}`, { stdio: "ignore" });
  });

  test("stores the RDB and the stream, and ROLE's offset is reached", async () => {
    const a = await client(16390);

    await a.call(["SET", "before", "sync"], ["SADD", "s", "1", "2", "3", "4"]);
    const link = await StreamLink.open(socket(16390), store, 1, null, () => {});

    expect(link.continued).toBe(false);
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
    await link.reached(await role(a), 5_000);
    expect(store.bytes(1, BASE)).toBeGreaterThan(0);
    expect(store.bytes(1, LOG)).toBeGreaterThan(2000 * 20);

    // Compaction: a second link takes generation 2 while the first keeps storing, then replaces it.
    const next = await StreamLink.open(socket(16390), store, 2, null, () => {});

    for (let i = 0; i < 500; i++) await a.send(["SET", `late${i}`, `x${i}`]);
    await a.read(500);
    await next.caughtUp(link);
    store.switchTo(next.generation);
    link.handOver(next);
    // WAIT puts a REPLCONF GETACK in the stream: the one frame a replay gets no reply for.
    await a.call(["DEL", "k5"], ["SET", "after", "switch"], ["WAIT", "1", "200"]);
    await next.reached(await role(a), 5_000);
    expect(current().gen).toBe(2);
    expect(store.bytes(1, LOG)).toBeGreaterThan(0); // generation 1 stays until pruned

    while (store.prune(1 << 20));
    expect(store.bytes(1, LOG)).toBe(0);
    expect(store.bytes(2, BASE)).toBeGreaterThan(0);
    next.close();
  });

  test("a server that kept running goes on from the last stored byte, with no new copy", async () => {
    const a = await client(16390);
    const g = current();

    await a.call(["SET", "while", "away"]); // written while no link stores the stream
    const end = g.offset + store.bytes(g.gen, LOG);

    // A server with another history (a restore cut short gets a new one) fails the link instead of sending a copy.
    const other = { from: g, replid: "0".repeat(40), offset: end, only: true };

    await expect(StreamLink.open(socket(16390), store, g.gen + 1, other, () => {})).rejects.toThrow(CANT_CONTINUE);
    expect(current().gen).toBe(g.gen);

    const resume = { from: g, replid: g.master ?? g.replid, offset: end, only: true };
    const link = await StreamLink.open(socket(16390), store, g.gen + 1, resume, () => {});

    expect(link.continued).toBe(true);
    store.switchTo(link.generation);
    await a.call(["SET", "after", "resume"]);
    await link.reached(await role(a), 5_000);
    expect(current().gen).toBe(g.gen);
    link.close();
  });

  test("a server built from storage alone has the same data, and goes on from its own history", async () => {
    await restored("vado-box-b", 16391);
    const [[digestA, sizeA], [digestB, sizeB]] = await Promise.all([digest(16390), digest(16391)]);

    expect(sizeB).toBe(sizeA);
    expect(digestB).toBe(digestA);

    const b = await client(16391);
    const [info = null] = await b.call(["INFO", "replication"]);
    const { master_replid: replid = "", master_repl_offset: offset = "0" } = infoFields(text(info));
    const g = current();
    const resume = { from: g, replid, offset: Number(offset), only: false };
    const link = await StreamLink.open(socket(16391), store, g.gen + 1, resume, () => {});

    expect(link.continued).toBe(true);
    store.switchTo(link.generation);
    await b.call(["SET", "after", "restore"], ["INCRBY", "n", "5"], ["DEL", "k9"]);
    await link.reached(await role(b), 5_000);
    link.close();
    await restored("vado-box-e", 16394);
    const [[digestB2], [digestE]] = await Promise.all([digest(16391), digest(16394)]);

    expect(digestE).toBe(digestB2);
  });

  test("a server restored from a bare base goes on with the stream, and storage keeps up with it", async () => {
    const fold = await StreamLink.open(socket(16390), store, current().gen + 1, null, () => {});

    store.switchTo(fold.generation);
    fold.close();
    expect(store.bytes(current().gen, LOG)).toBe(0);

    const g = current();

    serve("vado-box-c", 16392, concat([...store.chunks(g.gen, BASE)]));
    const c = await client(16392);
    const bare = { from: g, replid: g.replid, offset: g.offset, only: false };
    const link = await StreamLink.open(socket(16392), store, g.gen + 1, bare, () => {});

    expect(link.continued).toBe(true);
    store.switchTo(link.generation);
    await c.call(["SET", "on", "restored"], ["INCR", "n"], ["DEL", "k7"]);
    await link.reached(await role(c), 5_000);
    link.close();
    await restored("vado-box-d", 16393);
    const [[digestC], [digestD]] = await Promise.all([digest(16392), digest(16393)]);

    expect(digestD).toBe(digestC);
  });
});
