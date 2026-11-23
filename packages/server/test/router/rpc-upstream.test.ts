import { expect, test } from "vite-plus/test";
import { command } from "../../src/protocol/resp";
import { LOST } from "../../src/router/replies-text";
import { RpcUpstream } from "../../src/router/rpc-upstream";
import type { ShardStub, UpstreamOwner } from "../../src/router/types";
import { noop } from "../../src/shared";

test("a failed batch answers everything queued behind it and sends nothing more on its stub", async () => {
  let calls = 0,
    fail: (e: Error) => void = noop;

  const execRaw = async (_bytes: Uint8Array, _count: number, _proto?: 2 | 3): Promise<Uint8Array> => {
    calls++;

    return await new Promise<Uint8Array>((_, reject) => (fail = reject));
  };

  // SAFETY: RpcUpstream calls only execRaw on its stub.
  const stub = { execRaw } as ShardStub;

  const owner: UpstreamOwner = {
    now: 0,
    dial: "router",
    proto: 2,
    stubOf: () => stub,
    setup: () => [],
    wake: noop,
    push: noop,
    lostConnection: noop,
    dropUpstream: noop,
    endPassthrough: noop,
    dropped: () => command(["dropped"]),
  };

  const up = new RpcUpstream(owner, 0, stub),
    got: Uint8Array[] = [];

  up.send(command(["GET", "a"]), (f) => got.push(f));
  await Promise.resolve();
  up.send(command(["GET", "b"]), (f) => got.push(f));
  up.send(command(["GET", "c"]), (f) => got.push(f));
  await Promise.resolve();
  fail(new Error("boom"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(got).toEqual([LOST, LOST, LOST]);
  expect(calls).toBe(1);
  expect(up.dead).toBe(true);
  expect(up.inflight).toBe(0);
});
