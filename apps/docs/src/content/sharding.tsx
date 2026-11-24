import { GridFourIcon } from "@phosphor-icons/react";
import { Code, Note, Table } from "../components/blocks";
import { SlotDiagram } from "../components/diagrams/slots";
import { DocLink } from "../components/doc-link";
import { DIFFERENCES_SECTION } from "./sharding-differences";
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
            ["AUTH, PING, ECHO, HELLO, SELECT, CLIENT, CLUSTER, WAIT, WAITAOF", "Answered by the router itself"],
            ["CONFIG SET", "Every primary, if the setting is allowed; kept across restarts"],
            ["CONFIG GET, keyless commands", "Shard 0"],
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
            Objects that share a process share its memory limit and its single thread. In our tests, objects of one
            Durable Object class sometimes shared a process: 16 shards in one class ran in 14 processes, one holding 3
            shards. So the shard is exported as eight classes, and shard <code>i</code> uses class <code>i % 8</code>.
            With 8 classes, 16 shards ran in 16 processes.
          </p>
          <p>
            Replicas of class <code>k</code> live in class <code>8 + k</code>, a class no primary uses.
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
    DIFFERENCES_SECTION,
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
              ). Each shard keeps the settings its server accepted and sets them again whenever it restarts, since a
              server forgets them.
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
    server("settings.ts"),
  ],
};
