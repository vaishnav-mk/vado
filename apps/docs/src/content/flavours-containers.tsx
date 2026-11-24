import { Note, Steps } from "../components/blocks";
import { DocLink } from "../components/doc-link";
import type { DocSection } from "./types";

export const CONTAINER_SECTIONS: DocSection[] = [
  {
    id: "durability",
    title: "How a container shard stays durable",
    content: (
      <>
        <Steps
          items={[
            <>
              The shard's object is a replica of the server in its container. It stores the server's replication stream
              in its SQLite: an RDB from a full sync, then the effects of every write.
            </>,
            <>
              After each batch of client commands it appends <code>ROLE</code>, whose reply carries the server's
              replication offset. The batch's replies leave once the stream up to that offset is stored.
            </>,
            <>
              The output gate holds those replies until the storage write commits, as for a wasm shard (
              <DocLink slug="durability">durability</DocLink>).
            </>,
          ]}
        />
        <p>
          So an acknowledged write is in the object's storage, and no read sees a write that isn't. The container's
          memory can go at any moment: the server runs with no persistence of its own.
        </p>
      </>
    ),
  },
  {
    id: "restore",
    title: "Restores and fast wakes",
    content: (
      <>
        <p>A stopped or lost container comes back on the next command:</p>
        <Steps
          items={[
            <>
              A new container starts and takes the stored RDB over TCP before its server starts. A cut copy fails the
              server's RDB checksum, and another container takes it.
            </>,
            <>The server loads the RDB, and the stream stored since replays into it as plain commands.</>,
            <>
              The object becomes the server's replica again, continuing from the server's own history and offset, with
              no second copy.
            </>,
          ]}
        />
        <p>
          A restored server holds exactly what's stored, so the object only has to note where the server's offsets line
          up with its stored stream. A full sync happens only if the server refuses to continue. An idle shard folds its
          stream into a fresh base before it stops, so it wakes with nothing to replay.
        </p>
        <p>
          A server that kept running while its object restarted, on every deploy for example, is kept if it answers and
          can continue the stored stream from its last byte. One whose copy or replay was cut short can't, so its
          container is destroyed and the shard restores into a new one.
        </p>
        <p>
          Once the stored stream outgrows its base (64 MB at least), a second replica link takes a fresh RDB while the
          first keeps storing. The new generation takes over only once it holds everything the old one does, so storage
          stays near two bases and a restore replays at most one. The old generation is then deleted 8 MB at a time,
          with client traffic running in between: one delete of it all would hold every reply until it committed.
        </p>
        <p>
          A burst of new shards can outrun the instances the platform has ready; a boot waits up to 3 minutes for one.
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
          Each client connection gets a socket per shard, as with wasm shards, proxied to a server connection of its own
          and fenced the same way. Past an isolate's socket budget, batches go over RPC and share one pipelined server
          connection per shard. Transactions, pub/sub and blocking commands always get a socket.
        </p>
        <p>
          Pub/sub runs on shard 0's server: a container of its own would idle at full price. When that shard restarts,
          its subscribers are disconnected, and clients such as ioredis reconnect and subscribe again. Messages
          published in between are lost, as with any Redis-compatible server.
        </p>
        <Note>
          <p>
            Any one client connection is one Worker invocation, and every RPC call to a shard is a subrequest. The
            Worker raises its subrequest limit to 10 million so a busy connection isn't cut off at the default 10,000.
          </p>
        </Note>
      </>
    ),
  },
];
