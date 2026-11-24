import { expect, test } from "vite-plus/test";
import { migrate } from "../src/migrate";
import { str } from "../src/protocol/resp";
import { encoder } from "../src/shared";
import { keepSettings, reapply, settingsMigrations } from "../src/settings";
import { fakeStorage } from "./wasm-shard/vfs/fake-storage";

const OK = encoder.encode("+OK\r\n");

test("a shard keeps the CONFIG SET its server accepted, and sets it again after a restart", async () => {
  const storage = fakeStorage();

  migrate(storage, settingsMigrations);
  keepSettings(storage.sql, [["CONFIG", "SET", "maxmemory-policy", "allkeys-lru", "maxmemory", "1gb"]], OK);
  keepSettings(storage.sql, [["config", "set", "hash-max-listpack-entries", "64"]], encoder.encode("-ERR no\r\n"));
  keepSettings(storage.sql, [["CONFIG", "SET", "lfu-log-factor", "5"], ["PING"]], OK);
  keepSettings(storage.sql, [["SET", "maxmemory-policy", "x"]], OK);
  keepSettings(storage.sql, [["CONFIG", "SET", "maxmemory-policy", "allkeys-lfu"]], OK);
  const sent: string[] = [];

  await reapply(storage.sql, async (bytes) => {
    sent.push(str(bytes));

    return OK;
  });
  // Only what was accepted, alone in its batch, and allowed: the router refuses the rest before it gets here.
  expect(sent).toEqual(["*4\r\n$6\r\nCONFIG\r\n$3\r\nSET\r\n$16\r\nmaxmemory-policy\r\n$11\r\nallkeys-lfu\r\n"]);
});

test("nothing kept, nothing sent", async () => {
  const storage = fakeStorage();
  let calls = 0;

  migrate(storage, settingsMigrations);
  await reapply(storage.sql, async () => {
    calls++;

    return OK;
  });
  expect(calls).toBe(0);
});
