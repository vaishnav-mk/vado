import { Table } from "../components/blocks";
import type { DocSection } from "./types";

const PRICING = "https://developers.cloudflare.com/containers/platform/pricing/";
const LIMITS = "https://developers.cloudflare.com/containers/platform/limits/";

export const RUNNING_SECTIONS: DocSection[] = [
  {
    id: "idle",
    title: "Idle containers and cost",
    content: (
      <>
        <p>
          Ten minutes after its last client, a container shard folds its stream into a fresh base and stops its
          container, and its object can sleep. The dashboard watching a database doesn't count as a client. If the
          object was evicted first, the platform stops the container five minutes later. The next command restores the
          shard from storage.
        </p>
        <p>
          A running <code>standard-1</code> container costs about $0.038 an hour for its 4 GiB of memory and 8 GB of
          disk, plus up to $0.036 an hour of CPU while busy (<a href={PRICING}>Containers pricing</a>). That is per
          shard, on top of its Durable Object.
        </p>
      </>
    ),
  },
  {
    id: "limits",
    title: "Limits",
    content: (
      <ul>
        <li>
          2 GB of data per shard. More memory alone wouldn't help: the object's storage (10 GB) holds a base, the stream
          since it, and a second base during a compaction.
        </li>
        <li>
          Shards per database: 1, 4, 16 or 64 from the dashboard; more through the bench API. Tested up to 64 shards
          with 10.7 GB of data.
        </li>
        <li>
          Every running shard is a container under the account's limits (<a href={LIMITS}>Containers limits</a>): 60 TiB
          of memory and 15,000 vCPU at once by default, so about 15,000 shards at 4 GiB each.
        </li>
        <li>The shard count is fixed when a database is created, as for wasm databases.</li>
        <li>No read replicas, and a restore takes longer the more a shard holds.</li>
      </ul>
    ),
  },
  {
    id: "measured",
    title: "Measured",
    content: (
      <>
        <Table
          headers={["Test", "Valkey", "Redis"]}
          rows={[
            [
              "64 shards, 10.7 GB of random values: every container and object destroyed at once, 2 runs",
              "All back with identical data: median 3.0-3.2 s, slowest 4.3-4.4 s",
              "Median 3.5-3.6 s, slowest 5.3-5.7 s",
            ],
            [
              "The same, containers destroyed while their objects kept running, 2 runs",
              "Median 3.3-3.9 s, slowest 4.2-5.2 s",
              "Median 3.8-4.1 s, slowest 5.0-6.1 s",
            ],
            ["The same, only the objects restarted", "Median 1.0 s, slowest 1.3 s", "Median 1.1 s, slowest 1.5 s"],
            [
              "A shard holding 170 MB, ready again (174 restores, both servers together)",
              "Median 1.1 s, p90 1.35 s: 0.5 s copying, 0.55 s loading, no second copy",
              "Counted with Valkey's",
            ],
            [
              "Acknowledged writes, every container and object destroyed",
              "50,000 on 64 and 16 shards: 0 missing, 0 wrong",
              "50,000 on 64 shards: 0 missing, 0 wrong",
            ],
            [
              "test/hammer.mjs, 32 clients",
              "11 of 11 checks on 16 shards, also with 26 shard aborts during it",
              "11 of 11 on 64 shards, also with 37 aborts",
            ],
            ["test/differential.mjs", "Passed", "Passed, 1,100 commands"],
            [
              "64 load generators inside Cloudflare, each on its own shard",
              "376k SET/s and 568k GET/s summed",
              "305k SET/s and 351k GET/s (64 wasm shards: 357k and 390k)",
            ],
            ["GET from the router, one at a time", "", "p50 41-43 ms (a wasm shard: 40-41 ms)"],
            ["Compaction of a shard holding 68 MB", "", "18.8 s, with writes running throughout"],
          ]}
        />
        <p>
          One run each unless noted, on one account, from a router in India; an empty cell wasn't measured. The restore
          times run until a script has read every value on every shard back. The throughput rows are bound by each
          generator's round trips, not by the shards, and were measured on different days.
        </p>
      </>
    ),
  },
];
