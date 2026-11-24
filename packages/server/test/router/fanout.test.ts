import { expect, test } from "vite-plus/test";
import type { CommandArg } from "../../src/protocol/types";
import type { ShardStub } from "../../src/router/types";
import { client } from "./fake-shard";

test("a command sent to every shard keeps its arguments' bytes", async () => {
  const got: CommandArg[][][] = [];

  // SAFETY: KEYS reaches its shards only through runRaw.
  const stub = {
    runRaw: (cmds: CommandArg[][]) => {
      got.push(cmds);

      return Promise.resolve(new TextEncoder().encode("*0\r\n"));
    },
  } as ShardStub;

  const c = client([stub, stub], stub);
  const pattern = Uint8Array.of(0xff, 0x2a);
  const head = new TextEncoder().encode("*2\r\n$4\r\nKEYS\r\n$2\r\n");

  await c.send(Uint8Array.from([...head, ...pattern, 0x0d, 0x0a]));
  expect(await c.read(4)).toBe("*0\r\n");
  await c.close();

  expect(got).toHaveLength(2);

  for (const [[, arg]] of got) expect(arg).toEqual(pattern);
});

test("SCAN without a cursor and RANDOMKEY with arguments get arity errors, as from Valkey", async () => {
  // SAFETY: neither command reaches a shard.
  const stub = {
    runRaw: (_cmds: CommandArg[][]): Promise<Uint8Array> => Promise.reject(new Error("not asked")),
  } as ShardStub;

  const c = client([stub], stub);

  await c.call("SCAN");
  await c.call("RANDOMKEY", "x");

  const want = [
    "-ERR wrong number of arguments for 'scan' command\r\n",
    "-ERR wrong number of arguments for 'randomkey' command\r\n",
  ].join("");

  expect(await c.read(want.length)).toBe(want);
  await c.close();
});
