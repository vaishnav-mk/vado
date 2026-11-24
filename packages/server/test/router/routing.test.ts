import { expect, test } from "vite-plus/test";
import type { DatabaseRecord } from "../../src/catalog/types";
import { append } from "../../src/protocol/bytes";
import { command } from "../../src/protocol/resp";
import { Conn } from "../../src/router/conn";
import { replicaResting, setSocketBudget } from "../../src/router/isolate";
import { forward } from "../../src/router/routing";
import { socketPair } from "../../src/router/socket-pair";
import type { ShardStub } from "../../src/router/types";
import { noop } from "../../src/shared";

const enc = new TextEncoder();

test("a lost replica read goes again to the primary, with the bytes the client sent", async () => {
  // Every upstream uses RPC, so nothing dials.
  setSocketBudget(0);
  const sent: Uint8Array[] = [];

  // SAFETY: RPC upstreams call only execRaw on their stubs.
  const primary = {
    execRaw: (bytes: Uint8Array, _count: number, _proto?: 2 | 3): Promise<Uint8Array> => {
      sent.push(bytes);

      return Promise.resolve(enc.encode("$1\r\nv\r\n"));
    },
  } as ShardStub;

  // SAFETY: as above.
  const replica = {
    execRaw: (_bytes: Uint8Array, _count: number, _proto?: 2 | 3): Promise<Uint8Array> =>
      Promise.reject(new Error("replica gone")),
  } as ShardStub;

  const db: DatabaseRecord = {
    name: "routing-test",
    created: 0,
    shards: 1,
    regions: null,
    replicas: ["weur"],
    classes: null,
    secret: null,
    flavour: "valkey",
  };

  const [client, server] = socketPair();

  const c = new Conn(
    server,
    { db, table: new Map(), shard: () => primary, pubsub: () => primary, replica: () => replica },
    {
      password: undefined,
      trusted: true,
      lookup: () => Promise.resolve(null),
      open: () => Promise.reject(new Error("no other database")),
      onDropped: noop,
      signIns: null,
      idleMs: 30_000,
      dial: "router",
    },
  );

  // Like the router's read buffer: the next read is appended in place, past the views already handed out.
  const buf = append(append(enc.encode("*2\r\n$3\r\nGET\r\n"), enc.encode("$1\r\nk\r\n")), enc.encode("*1"));
  forward(c, 0, buf.subarray(0, buf.length - 2), true);
  expect(append(buf, enc.encode("\r\n$4\r\nPING\r\n")).buffer).toBe(buf.buffer);

  const { value } = await client.readable.getReader().read();

  expect(value).toEqual(enc.encode("$1\r\nv\r\n"));
  expect(sent).toEqual([command(["GET", "k"])]);
  expect(replicaResting(db.name, 0, Date.now())).toBe(true);
});
