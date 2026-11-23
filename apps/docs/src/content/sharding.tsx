import { GridFourIcon } from "@phosphor-icons/react";
import { Code, Note, Table } from "../components/blocks";
import { SlotDiagram } from "../components/diagrams/slots";
import { DocLink } from "../components/doc-link";
import { server } from "./sources";
import type { Doc } from "./types";

export const sharding: Doc = {
  slug: "sharding",
  title: "Sharding and routing",
  group: "How it works",
  icon: GridFourIcon,
  description:
    "Keys hash to 16,384 slots, slots map to shards in contiguous ranges, and a database's size and placement are fixed when it is created.",
  keywords:
    "slots hashtag crc16 shard count epochs SHARD_EPOCHS placement regions LOCATION_HINT classes CROSSSLOT fan-out socket budget unsupported commands",
  intro: <SlotDiagram />,
  sections: [
    {
      id: "slots",
      title: "Slots and shards",
      content: (
        <p>
          A key hashes to one of 16,384 slots with CRC16, as in Valkey Cluster, and a <code>{"{hashtag}"}</code> hashes
          only the part in braces. Shard <code>i</code> of <code>n</code> owns a contiguous range of slots, so a shard
          could later split without remapping its neighbours. A 1-shard database has no cross-slot limits.
        </p>
      ),
    },
    {
      id: "epochs",
      title: "Shard count",
      content: (
        <>
          <p>
            A database is created on first use with the shard count of the <code>SHARD_EPOCHS</code> entry in force at
            that moment, or with an explicit count through the bench API (<code>{"/db?db=<name>&shards=<n>"}</code>).
          </p>
          <Code label="SHARD_EPOCHS, ordered by from, the first at 0">
            {'[\n  { "from": 0, "shards": 1 },\n  { "from": 1800000000000, "shards": 16 }\n]'}
          </Code>
          <p>
            Append an epoch to size new databases. Never edit an existing one: its databases would route to the wrong
            shards.
          </p>
        </>
      ),
    },
    {
      id: "placement",
      title: "Placement",
      content: (
        <>
          <p>
            With a <code>regions</code> list (<code>regions=weur,enam</code>, or <code>regions=world</code> for all
            nine), shard <code>i</code> is created with the location hint <code>regions[i % n]</code>. Without one,
            shards go to <code>LOCATION_HINT</code> if set, or near their first caller. The pub/sub shard always uses{" "}
            <code>LOCATION_HINT</code>.
          </p>
          <p>
            A hint applies when an object is created; an existing shard keeps its place. Durable Objects hinted to{" "}
            <code>sam</code>, <code>afr</code> or <code>me</code> run in a nearby region instead. The dashboard shows
            where each shard actually runs.
          </p>
        </>
      ),
    },
    {
      id: "routing",
      title: "How the router routes",
      content: (
        <Table
          headers={["Command", "Where it goes"]}
          rows={[
            ["Keys in one slot", "That shard, unchanged and pipelined, or a nearby replica for reads"],
            ["MGET, MSET, DEL, UNLINK, EXISTS, TOUCH", "Split by shard, replies merged in key order"],
            ["SCAN, KEYS, DBSIZE, FLUSHALL, INFO", "Every shard, 32 at a time, after every earlier reply"],
            ["SCRIPT LOAD, FUNCTION LOAD", "Every shard, so EVALSHA and FCALL work wherever their keys land"],
            ["SUBSCRIBE, PUBLISH", "The database's pub/sub shard"],
            ["AUTH, HELLO, SELECT, CLIENT, WAIT, WAITAOF, CONFIG", "Answered by the router itself"],
          ]}
        />
      ),
    },
    {
      id: "crossslot",
      title: "CROSSSLOT",
      content: (
        <>
          <p>
            Other multi-key commands with keys in different slots get <code>CROSSSLOT</code>, and so do MULTI, WATCH and
            Lua over keys in different slots. Put related keys under one <code>{"{hashtag}"}</code>, or use a 1-shard
            database. A transaction always runs on its shard's socket.
          </p>
          <p>
            The commands the router answers itself are refused inside MULTI: queued, they would reach one shard's
            connection instead of the router.
          </p>
        </>
      ),
    },
    {
      id: "classes",
      title: "Shard classes",
      content: (
        <>
          <p>
            Objects of one Durable Object class on one machine can share a process, and with it the memory limit and the
            single thread. Objects of different classes never do. So the shard is exported as eight classes, and shard{" "}
            <code>i</code> uses class <code>i % 8</code>: a database's shards 0 to 7 never share a process.
          </p>
          <p>
            Replicas of class <code>k</code> live in class <code>8 + k</code>, so a replica never shares a process with
            a primary. In tests, 16 shards in one class ran in 14 processes, one holding 3 shards; with 8 classes they
            ran in 16.
          </p>
        </>
      ),
    },
    {
      id: "connections",
      title: "Connections",
      content: (
        <>
          <p>
            Each router opens a socket to every shard and replica it uses, which keeps per-shard order for free. Past
            128 sockets in one Worker process (<code>ROUTER_SOCKET_BUDGET</code>), new upstreams send batches of
            commands as method calls instead, which cost more per batch: 200 connections over 16 shards measured about
            20 to 26k ops/s.
          </p>
          <p>
            Shard sockets idle for 30 s close, so an idle shard stops being billed and can sleep. The client's
            connection doesn't notice.
          </p>
        </>
      ),
    },
    {
      id: "unsupported",
      title: "Unsupported commands",
      content: (
        <>
          <p>
            MONITOR; SYNC, PSYNC, REPLICAOF and FAILOVER (replication is internal); SHUTDOWN, DEBUG, MIGRATE, MOVE,
            SWAPDB, SAVE, BGSAVE, BGREWRITEAOF and ACL; CLIENT TRACKING and the other connection-wide CLIENT
            subcommands; SELECT above 0 (use another database name); CONFIG inside MULTI.
          </p>
          <Note>
            <p>
              <code>CONFIG SET</code> takes only settings that change how data behaves (
              <DocLink slug="security" hash="config">
                the list
              </DocLink>
              ).
            </p>
          </Note>
        </>
      ),
    },
  ],
  sources: [
    server("protocol/slots.ts"),
    server("catalog/epochs.ts"),
    server("catalog/placement.ts"),
    server("router/split.ts"),
    server("router/fanout.ts"),
    server("router/command-sets.ts"),
  ],
};
