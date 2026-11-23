import { GlobeHemisphereWestIcon } from "@phosphor-icons/react";
import { Code, Flow, Note, Table } from "../components/blocks";
import { server } from "./sources";
import type { Doc } from "./types";

export const replicas: Doc = {
  slug: "replicas",
  title: "Read replicas",
  group: "How it works",
  icon: GlobeHemisphereWestIcon,
  description:
    "Each shard can keep a memory-only copy in other regions, fed from its AOF. Routers read the nearest one, a connection always reads its own writes, and an idle database's replicas sleep.",
  keywords: "replicas regions replication read your writes WAIT WAITAOF staleness lag copy stream idle sleep NEAR",
  sections: [
    {
      id: "regions",
      title: "Regions",
      content: (
        <>
          <p>
            With a <code>replicas</code> list, every data shard keeps one replica in each listed region. Writes always
            go to the primary. Like the shard count, the list is fixed when the database is created.
          </p>
          <Code label="Bench API">
            {'curl -H "authorization: Bearer $TOKEN" "$BASE/db?db=mydb&shards=4&replicas=world"'}
          </Code>
          <p>
            A router maps where it runs to one of the nine regions and reads from the replica there, including the
            primary's own region. With none there, it tries a neighbour; with no match, the primary.
          </p>
          <Table
            headers={["Router in", "Then tries"]}
            rows={[
              ["wnam, enam", "each other"],
              ["weur, eeur", "each other"],
              ["apac, oc", "each other"],
              ["sam", "enam, wnam"],
              ["me", "eeur, weur"],
              ["afr", "weur, eeur"],
            ]}
          />
        </>
      ),
    },
    {
      id: "copy-then-stream",
      title: "Copy, then stream",
      content: (
        <>
          <Flow
            items={[
              "FLUSHALL",
              "Base and incremental files, 1 MB at a time",
              "Appends since",
              "PING marker",
              "Serving",
            ]}
          />
          <p>
            The primary sends its AOF files as commands, then every append after them, over one socket per replica. The
            stream leaves through the primary's output gate like its replies, so{" "}
            <strong>a replica only receives committed writes</strong>. Its <code>+PONG</code> to the marker means it has
            run everything before it, and only then does it serve reads.
          </p>
          <p>
            Replicas run with <code>import-mode</code> and no memory limit, so they never expire or evict keys on their
            own. Reads still hide expired keys, and the primary's stream deletes them.
          </p>
        </>
      ),
    },
    {
      id: "read-your-writes",
      title: "What a replica read can see",
      content: (
        <>
          <p>A read goes to a replica only if all of these hold, and to the primary otherwise:</p>
          <ul>
            <li>It is read-only, doesn't block, and its keys are in one slot.</li>
            <li>The connection is not in MULTI and has no active WATCH.</li>
            <li>The connection has no write in flight to that shard, and none answered in the last 2 s.</li>
            <li>No router in the same process saw that replica fail in the last 5 s.</li>
          </ul>
          <p>
            So a connection reads its own writes while replicas are under 2 s behind. A read on another connection can
            be one replication lag old: p50 3 to 41 ms, p99 38 to 141 ms across nine regions at light load.
          </p>
          <p>
            <code>WAIT numreplicas timeout</code> returns how many replicas have every write the connection made,
            counting the shard it wrote to with the fewest. It adds visibility, not durability. <code>WAITAOF</code>{" "}
            answers <code>1 0</code>, since every reply already waited for its shard's commit.
          </p>
        </>
      ),
    },
    {
      id: "failures",
      title: "Failures",
      content: (
        <ul>
          <li>
            <strong>A replica resets.</strong> It starts empty and refuses reads. The primary copies it again 5 s later,
            and reads go to the primary meanwhile.
          </li>
          <li>
            <strong>A replica falls behind.</strong> Unsent replication bytes count toward the primary's 16 MB input
            budget, so lagging replicas slow writes down. One more than 8 MB behind, or silent for 60 s, is dropped and
            copied again.
          </li>
          <li>
            <strong>The primary resets.</strong> Its replicas keep serving what they have, which may miss its last
            writes, until it copies them again, about 10 s later.
          </li>
          <li>
            <strong>The primary stops streaming</strong> to a replica it drops: it tells the replica to reset, so a
            replica never serves data that has stopped updating.
          </li>
        </ul>
      ),
    },
    {
      id: "idle",
      title: "Idle sleep",
      content: (
        <>
          <p>
            After 10 minutes with no writes, no client activity on the primary and no replica reads, the primary retires
            its replicas, closes the streams and stops its alarm, so every object can be evicted. The next activity
            wakes it and it copies every replica again. A read meanwhile finds its replica retired and goes to the
            primary, which wakes it too.
          </p>
          <Note>
            <p>
              Replicas cost the primary write throughput: one shard with 9 replicas took 49 to 61k SET/s, against about
              130k with none. A replica is also a full copy of the shard's data in that region.
            </p>
          </Note>
        </>
      ),
    },
  ],
  sources: [
    server("replication/replicator.ts"),
    server("replication/config.ts"),
    server("router/read-your-writes.ts"),
    server("router/routing.ts"),
    server("catalog/placement.ts"),
    server("shard/replica.ts"),
  ],
};
