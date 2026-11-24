import { Facts } from "../components/blocks";
import { ByServer, ServerBadge } from "../components/server";
import type { DocSection } from "./types";

const PRICING = "https://developers.cloudflare.com/containers/platform/pricing/";
const LIMITS = "https://developers.cloudflare.com/containers/platform/limits/";

export const RUNNING_SECTIONS: DocSection[] = [
  {
    id: "idle",
    title: "Idle containers and cost",
    content: (
      <>
        <ul>
          <li>
            <strong>Ten minutes</strong> after its last client, a container shard folds its stream into a fresh base and
            stops its container. Its object can then sleep.
          </li>
          <li>The dashboard watching a database doesn't count as a client.</li>
          <li>
            If the object was evicted first, the platform stops the container <strong>five minutes</strong> later.
          </li>
          <li>The next command restores the shard from storage.</li>
        </ul>
        <Facts
          items={[
            [
              <>
                A running <code>standard-1</code> container
              </>,
              <>
                About <strong>$0.038 an hour</strong>, for its 4 GiB of memory and 8 GB of disk
              </>,
            ],
            [
              "CPU while busy",
              <>
                Up to <strong>$0.036 an hour</strong> more
              </>,
            ],
            ["Applies to", "Each shard, on top of its Durable Object"],
          ]}
        />
        <p>
          Prices from <a href={PRICING}>Containers pricing</a>.
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
          <strong>2 GB</strong> of data per shard. More memory alone wouldn't help. The object's storage (10 GB) holds a
          base, the stream since it, and a second base during a compaction.
        </li>
        <li>
          Shards per database: 1, 4, 16 or 64 from the dashboard, more through the bench API. Tested up to{" "}
          <strong>64 shards with 10.7 GB</strong> of data.
        </li>
        <li>
          Every running shard is a container under the account's limits (<a href={LIMITS}>Containers limits</a>). The
          defaults are 60 TiB of memory and 15,000 vCPU at once, a ceiling of about 15,000 shards at 4 GiB each.
        </li>
        <li>The shard count is fixed when a database is created, as for wasm databases.</li>
        <li>
          <strong>No read replicas</strong> yet.
        </li>
        <li>A restore takes longer the more a shard holds.</li>
      </ul>
    ),
  },
  {
    id: "measured",
    title: "Measured",
    content: (
      <>
        <p>How these were measured:</p>
        <ul>
          <li>One run each unless noted, on one account, from a router in India.</li>
          <li>The restore times run until a script has read every value on every shard back.</li>
          <li>The third run of each restore test came after 20,000 writes, so it replayed a stream.</li>
          <li>
            The throughput numbers are bound by each generator's round trips, not by the shards. They were measured on
            different days.
          </li>
        </ul>
        <p>
          Results for <ServerBadge />, the server picked in the header.
        </p>
        <h3>Restores</h3>
        <Facts
          items={[
            [
              "64 shards, 10.7 GB of random values, every container and object destroyed at once, 3 runs",
              <ByServer
                valkey="All back with identical data. Median 3.0-4.3 s, slowest 4.3-6.1 s"
                redis="Median 3.5-5.5 s, slowest 5.3-9.8 s"
              />,
            ],
            [
              "The same, containers destroyed while their objects kept running, 3 runs",
              <ByServer valkey="Median 3.3-4.2 s, slowest 4.2-6.3 s" redis="Median 3.8-5.5 s, slowest 5.0-8.2 s" />,
            ],
            [
              "The same, only the objects restarted",
              <ByServer valkey="Median 1.0 s, slowest 1.3 s" redis="Median 1.1 s, slowest 1.5 s" />,
            ],
            [
              "A shard holding 170 MB, ready again, 174 restores, both servers together",
              "Median 1.1 s, p90 1.35 s. That is 0.5 s copying and 0.55 s loading, with no second copy",
            ],
          ]}
        />
        <h3>Correctness</h3>
        <Facts
          items={[
            [
              "Acknowledged writes, every container and object destroyed",
              <ByServer
                valkey="50,000 on 64 and 16 shards: 0 missing, 0 wrong"
                redis="50,000 on 64 shards: 0 missing, 0 wrong"
              />,
            ],
            [
              <>
                <code>test/hammer.mjs</code>, 32 clients
              </>,
              <ByServer
                valkey="11 of 11 checks on 16 shards, also with 26 shard aborts during it"
                redis="11 of 11 on 64 shards, also with 37 aborts"
              />,
            ],
            [<code>test/differential.mjs</code>, <ByServer valkey="Passed" redis="Passed, 1,100 commands" />],
          ]}
        />
        <h3>Speed</h3>
        <Facts
          items={[
            [
              "64 load generators inside Cloudflare, each on its own shard",
              <ByServer
                valkey="376k SET/s and 568k GET/s summed"
                redis="305k SET/s and 351k GET/s (64 wasm shards: 357k and 390k)"
              />,
            ],
            [
              "GET from the router, one at a time, 2 runs",
              <ByServer valkey="p50 43-44 ms" redis="p50 43 ms (a wasm shard: 41-42 ms)" />,
            ],
            [
              "Compaction of a 170 MB base, 4 clients writing 64 KB values throughout",
              <ByServer
                valkey="10.5 s, 8.5 s of it copying. Slowest GET meanwhile 1.7 s, no failed writes"
                redis="8.0 s, 5.9 s of it copying. Slowest GET meanwhile 1.2 s, no failed writes"
              />,
            ],
          ]}
        />
      </>
    ),
  },
];
