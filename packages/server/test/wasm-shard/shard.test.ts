import { expect, test } from "vite-plus/test";
import { infoFields, subField } from "../../src/protocol/info";
import { droppable } from "../../src/wasm-shard/tombstone";
import { mayRestart } from "../../src/wasm-shard/upgrade";
import { valkeyArgs } from "../../src/wasm-shard/valkey-args";
import { deployedAt, dialedFrom } from "../../src/shard/version";

const version = (timestamp: string) => ({ VERSION: { id: "v", tag: "", timestamp } });

test("deployedAt reads the version's timestamp, or 0", () => {
  expect(deployedAt(version("2026-01-02T03:04:05.000Z"))).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
  expect(deployedAt(version(""))).toBe(0);
});

test("dialedFrom reads the deploy time in a dial address", () => {
  expect(dialedFrom("router-1700000000000", "router")).toBe(1700000000000);
  expect(dialedFrom("router", "router")).toBeNull();
  expect(dialedFrom("repl-42", "repl")).toBe(42);
  expect(dialedFrom("repl-42", "router")).toBeNull();
  expect(dialedFrom("valkey", "router")).toBeNull();
});

test("valkeyArgs: primaries keep an AOF, replicas import with no memory limit", () => {
  const primary = valkeyArgs({}, false);
  const replica = valkeyArgs({ VALKEY_MAXMEMORY: "32mb" }, true);

  expect(primary.join(" ")).toContain("--appendonly yes --appendfsync always");
  expect(primary.join(" ")).toContain("--maxmemory 64mb");
  expect(replica.join(" ")).toContain("--appendonly no");
  expect(replica.join(" ")).toContain("--import-mode yes --maxmemory 3gb");
  expect(replica).not.toContain("32mb");
});

test("mayRestart: newer code only, at most 3 tries per deploy, 30 s apart", () => {
  const now = 1_000_000;

  expect(mayRestart(100, 200, 0, null, now)).toBe(true);
  expect(mayRestart(0, 200, 0, null, now)).toBe(false); // own deploy unknown
  expect(mayRestart(200, 200, 0, null, now)).toBe(false); // already on it
  expect(mayRestart(100, 200, 3, null, now)).toBe(false);
  expect(mayRestart(100, 200, 2, now - 29_999, now)).toBe(false);
  expect(mayRestart(100, 200, 2, now - 30_000, now)).toBe(true);
});

test("a dropped shard keeps its tombstone and the runtime's tables", () => {
  const tables = ["dropped", "vfs_node", "_cf_KV", "sqlite_sequence", "restarts", "durability_alarms"];

  expect(tables.filter(droppable)).toEqual(["vfs_node", "restarts", "durability_alarms"]);
});

test("infoFields reads an INFO reply's raw bytes", () => {
  const fields = infoFields("$40\r\n# Persistence\r\naof_base_size:10\r\naof_current_size:25\r\n\r\n");

  expect(fields).toEqual({ aof_base_size: "10", aof_current_size: "25" });
});

test("subField reads one number from a keyspace or cmdstat value", () => {
  expect(subField("keys=3,expires=1,avg_ttl=0", "expires")).toBe(1);
  expect(subField("calls=12,usec=40,usec_per_call=3.33", "calls")).toBe(12);
  expect(subField("keys=3", "expires")).toBe(0);
  expect(subField(undefined, "keys")).toBe(0);
});
