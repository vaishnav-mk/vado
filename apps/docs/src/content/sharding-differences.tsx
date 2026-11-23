import type { DocSection } from "./types";

export const DIFFERENCES_SECTION: DocSection = {
  id: "differences",
  title: "Differences from one server",
  content: (
    <>
      <p>Most commands run in the server itself. These don't behave as they would on one server:</p>
      <ul>
        <li>
          The router answers PING, ECHO, SELECT, CLIENT, HELLO, CLUSTER, WAIT and WAITAOF itself, and merges SCAN and
          KEYS from every shard.
        </li>
        <li>
          INFO (apart from Keyspace), CONFIG GET and keyless commands such as SLOWLOG, LATENCY, MEMORY STATS and TIME
          report shard 0 only.
        </li>
        <li>
          MSET, DEL and the other split commands aren't atomic across shards: if one shard fails, the others have
          applied. FLUSHALL isn't atomic across shards either.
        </li>
        <li>
          Keyspace notifications and PUBLISH from Lua don't reach subscribers, because subscriptions live on a separate
          pub/sub shard.
        </li>
        <li>No modules: dlopen is off, so none of Redis 8's bundled JSON, Search or TimeSeries. MODULE LOAD fails.</li>
        <li>
          Script timeouts can't fire, because the Workers clock doesn't move while a command runs. A runaway EVAL runs
          until the shard's CPU limit resets it, and every client on that shard gets the lost-connection error.
        </li>
        <li>Slowlog and latency durations read as 0, for the same reason.</li>
        <li>UNLINK and FLUSHALL ASYNC run synchronously, since there are no background threads.</li>
      </ul>
    </>
  ),
};
