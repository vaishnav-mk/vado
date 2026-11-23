import { Table } from "../components/blocks";
import { ByServer, ServerBadge, ServerName } from "../components/server";
import { SERVERS } from "./servers";
import type { ServerFacts } from "./servers";
import type { DocSection } from "./types";

const measured = (pick: (facts: ServerFacts) => string) => (
  <ByServer valkey={pick(SERVERS.valkey)} redis={pick(SERVERS.redis)} />
);

export const RESULT_SECTIONS: DocSection[] = [
  {
    id: "throughput",
    title: "Throughput",
    content: (
      <>
        <Table
          headers={["Load", "Result"]}
          rows={[
            ["Deep pipelines straight to one shard", "114-130k SET/s, 250-306k GET/s"],
            ["16 shards through the router, 8 load generators", "255-304k SET/s with group commit, 48-66k before it"],
            ["Rows written per write, under that load", "About 0.008 with group commit, 0.26 before it"],
            ["64 shards, 640 connections, 1-byte values", "219k SET/s in a burst of tens of seconds, 0 errors"],
            ["200 connections over 16 shards", "20-26k ops/s: past the socket budget, on batched calls"],
          ]}
        />
        <p>
          Bursts, not a sustained ceiling. From a single laptop over TCP, throughput is bound by its round trips:
          valkey-benchmark with 200 connections and 64-deep pipelines reached 45.5k SET/s on one shard.
        </p>
        <p>
          <ServerBadge /> A pipeline of 20,000 mixed commands over Spectrum TCP from one laptop ran at{" "}
          {measured((facts) => facts.pipeline)}.
        </p>
      </>
    ),
  },
  {
    id: "latency",
    title: "Latency",
    content: (
      <>
        <Table
          headers={["Command", "p50", "p99"]}
          rows={[
            ["PING, answered by the router", "10-12 ms", "40 ms"],
            ["GET", "54 ms", "95 ms"],
            ["SET", "57-60 ms", "173-330 ms"],
            ["Connect, AUTH, PING", "85 ms", "211 ms (p90)"],
          ]}
        />
        <p>
          One TCP connection through Spectrum, one command at a time, shards 15 to 45 ms from the router. Nearly
          everything past the first 10 ms is the Worker's hop to the shard. A write adds one storage commit, which
          measured 10 to 38 ms p50 from inside a shard, depending on its region.
        </p>
      </>
    ),
  },
  {
    id: "replicas",
    title: "Replicas",
    content: (
      <Table
        headers={["Check, replicas in all nine regions", "Result"]}
        rows={[
          ["Every replica serving after the database was created", "Within seconds"],
          ["A second client reads a write acknowledged to the first", "p50 3-41 ms, p99 38-141 ms"],
          ["Keys written, then read back from every region", "20,000 of 20,000"],
          ["Read-your-writes on one connection", "0 stale in 2,700 checks"],
          ["WAIT 9 after writes to 3 shards", "About 0.9 s, the slowest replica's round trip"],
          ["Replica GET p99 while its primary rewrote under load", "45 ms, against a primary max of 318-1117 ms"],
        ]}
      />
    ),
  },
  {
    id: "rewrites",
    title: "Rewrites",
    content: (
      <Table
        headers={["35.6 MB base", "Time", "PINGs during it"]}
        rows={[
          ["Inline", "1.4-1.9 s", "Blocked for the whole rewrite"],
          ["In a rewriter", "5.2-5.9 s end to end", "p99 128-175 ms"],
          ["16 shards rewriting at once, under writes", "Slowest 1.42 s", "All ran in rewriters"],
          ["300,000 writes across a rewrite, then a restart", "0 missing", "Also with replicas in 2 regions"],
        ]}
      />
    ),
  },
  {
    id: "cold-starts",
    title: "Cold starts",
    content: (
      <>
        <p>
          <ServerBadge /> Over TCP from one client to shards in one region. The <ServerName /> wasm module is{" "}
          {measured((facts) => facts.wasm)}.
        </p>
        <Table
          headers={["Event", "Time"]}
          rows={[
            ["First SET on a new database", measured((facts) => facts.firstSet)],
            ["Next SET", measured((facts) => facts.nextSet)],
            ["First GET after the shard restarts, 16 MB of data", measured((facts) => facts.firstGet16)],
            ["First GET after the shard restarts, 56 MB of data", measured((facts) => facts.firstGet56)],
          ]}
        />
      </>
    ),
  },
  {
    id: "failure-tests",
    title: "Failure tests",
    content: (
      <Table
        headers={["Test", "Result"]}
        rows={[
          ["50,000 acknowledged writes, then every shard aborted", "0 missing"],
          ["test/hammer.mjs with CHAOS=1", "11 of 11 invariants held through 35 shard aborts"],
          ["Connection churn: connect, AUTH, write, read, close", "6,995 of 7,000 connections"],
          ["test/differential.mjs, 1 shard against N", "Identical replies"],
          ["36 replicas, 20,000 keys", "All read back in each of 9 regions"],
        ]}
      />
    ),
  },
];
