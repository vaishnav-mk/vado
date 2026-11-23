import { Table } from "../components/blocks";
import type { DocSection } from "./types";

const PRICING = "https://developers.cloudflare.com/containers/platform/pricing/";
const LIMITS = "https://developers.cloudflare.com/containers/platform/limits/";

export const NATIVE_RUN_SECTIONS: DocSection[] = [
  {
    id: "idle",
    title: "Idle shards and cost",
    content: (
      <>
        <p>
          About 10 minutes after its last client, a shard's container stops and its object can sleep. The dashboard
          watching a database doesn't count as a client. The next command restores the shard from storage.
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
          headers={["Test", "Result"]}
          rows={[
            [
              "64 shards, 10.7 GB of random values, every container destroyed at once",
              "All 64 back with identical data in 6 runs: median 11-13 s; slowest 19-21 s in five, 611 s in one (not yet explained)",
            ],
            ["The same, containers destroyed while their objects kept running", "Median 10-11 s, slowest 19-21 s"],
            [
              "A shard holding 170 MB, ready again (294 restores)",
              "Median 3.8 s, p90 9.1 s: 0.7 s copying, 0.8 s loading, 2.2 s syncing a new generation",
            ],
            ["50,000 acknowledged writes on 64 shards, every container destroyed", "0 missing, 0 wrong"],
            ["test/hammer.mjs on 64 shards, 32 clients", "11 of 11 checks, also with 37 shard aborts during it"],
            ["test/differential.mjs against real Redis", "Passed, 1,100 commands"],
            [
              "64 load generators inside Cloudflare, each on its own shard",
              "305k SET/s and 351k GET/s summed (64 wasm shards: 357k and 390k)",
            ],
            ["GET from the router, one at a time", "p50 41-43 ms (a wasm shard: 40-41 ms)"],
            ["Compaction of a shard holding 68 MB", "18.8 s, with writes running throughout"],
          ]}
        />
        <p>
          One run each unless noted, on one account, from a router in India. The throughput rows are bound by each
          generator's round trips, not by the shards.
        </p>
      </>
    ),
  },
];
