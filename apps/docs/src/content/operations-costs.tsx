import { Note } from "../components/blocks";
import type { DocSection } from "./types";

const PRICING = "https://developers.cloudflare.com/durable-objects/platform/pricing/";

export const COSTS_SECTION: DocSection = {
  id: "costs",
  title: "Costs",
  content: (
    <>
      <p>
        Durable Objects are billed for requests, for storage, and for duration: wall-clock time while an object is
        active, charged for its full 128 MB whatever it uses (<a href={PRICING}>Cloudflare's pricing page</a>). Every
        shard, replica and helper in vado is an object.
      </p>
      <p>These keep objects active, and billed:</p>
      <ul>
        <li>
          <strong>Open client connections.</strong> Each one reports to Pulse every 2 s, and its router keeps a socket
          to each shard it used until that socket has been idle for 30 s (<code>ROUTER_IDLE_MS</code>). A subscribed
          connection holds the pub/sub shard for as long as it stays open.
        </li>
        <li>
          <strong>Replicas.</strong> While a database's replicas are awake, every replica and its primary stay active,
          and the primary's alarm runs every 2 s. They sleep after 10 minutes with no client activity (
          <code>REPL_IDLE_MS</code>).
        </li>
        <li>
          <strong>A dashboard tab watching a database.</strong> Its Watcher polls every shard and replica each second.
        </li>
        <li>
          <strong>Test traffic</strong> from the dashboard or the bench API, until it stops.
        </li>
      </ul>
      <p>
        A shard with no sockets, requests or alarms is evicted, and isn't billed for duration until something wakes it.
        Its stored data is still billed.
      </p>
      <p>
        <strong>An example, at list price when written.</strong> One object kept active for a 30-day month is 2,592,000
        s at 0.125 GB, or 324,000 GB-s. At $12.50 per million GB-s that is $4.05. Workers Paid includes 400,000 GB-s a
        month per account and has a $5 monthly minimum. A 16-shard database with a replica in each of the nine regions
        is 160 such objects while its replicas are awake.
      </p>
      <Note>
        <p>
          Check the pricing page before you rely on these numbers. They change, and requests and storage add to them.
        </p>
      </Note>
    </>
  ),
};
