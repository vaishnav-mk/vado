import { expect, test } from "vite-plus/test";
import { EventLog, summarize, type Changes } from "./events";

const none: Changes = { restarts: [], replicas: [], rewrites: [] };
const texts = (changes: Partial<Changes>, shards = 4) => summarize({ ...none, ...changes }, shards).map((e) => e.text);

test("the same text within a minute counts up instead of adding an event", () => {
  const log = new EventLog();
  log.add({ level: "info", kind: "action", text: "a" }, 1000);
  log.add({ level: "info", kind: "action", text: "a" }, 2000);
  log.add({ level: "info", kind: "action", text: "b" }, 3000);
  log.add({ level: "info", kind: "action", text: "b" }, 70_000);

  expect(log.events.map((e) => [e.id, e.text, e.count, e.t])).toEqual([
    [3, "b", 1, 70_000],
    [2, "b", 1, 3000],
    [1, "a", 2, 2000],
  ]);
  expect(log.fresh().map((e) => e.id)).toEqual([1, 1, 2, 3]);
  expect(log.fresh()).toEqual([]);
});

test("restarts: a deploy of every shard is one event, other restarts one each", () => {
  const deploy = (i: number) => ({ i, deploy: true, backMs: null });
  expect(texts({ restarts: [0, 1, 2, 3].map(deploy) })).toEqual(["All 4 shards restarted for a new deploy"]);
  expect(texts({ restarts: [deploy(2)] })).toEqual(["Shard 2 restarted for a new deploy"]);
  expect(texts({ restarts: [deploy(0), deploy(1)] })).toEqual(["2 shards restarted for a new deploy"]);
  expect(texts({ restarts: [{ i: 1, deploy: false, backMs: 2345 }] })).toEqual([
    "Shard 1 restarted and was back in 2.3 s",
  ]);
});

test("rewrites", () => {
  expect(texts({ rewrites: [{ i: 0, ms: 1500, bytes: 3 * 2 ** 20, error: null }] })).toEqual([
    "Shard 0 compacted its log in 1.5 s, to 3.0 MB",
  ]);
  expect(
    texts({
      rewrites: [
        { i: 0, ms: 1500, bytes: null, error: null },
        { i: 1, ms: 2500, bytes: 10, error: null },
        { i: 2, ms: 1, bytes: null, error: "timeout" },
      ],
    }),
  ).toEqual([
    "Shard 2 couldn't compact its log in a helper, so it did it itself",
    "2 shards compacted their logs, the slowest in 2.5 s",
  ]);
});

test("replica changes are grouped by what happened", () => {
  const change = (i: number, from: string, to: string) => ({ i, region: "weur", from, to, error: null });
  const events = summarize({ ...none, replicas: [change(0, "ready", "asleep"), change(1, "ready", "asleep")] }, 4);
  expect(events).toEqual([
    { level: "info", kind: "replica", text: "2 replicas went to sleep: no traffic for 10 minutes" },
  ]);
  expect(summarize({ ...none, replicas: [change(3, "asleep", "copying"), change(1, "copying", "ready")] }, 4)).toEqual([
    {
      level: "info",
      kind: "replica",
      text: "New traffic woke the replica of shard 3 in western europe",
      shard: 3,
      region: "weur",
    },
    {
      level: "success",
      kind: "replica",
      text: "The replica of shard 1 in Western Europe is ready and serving reads",
      shard: 1,
      region: "weur",
    },
  ]);
});
