import { Checklist, Note, Steps } from "../components/blocks";
import { GenerationsDiagram } from "../components/diagrams/flavours-generations";
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
              The shard's object is a <strong>replica</strong> of the server in its container. It stores the server's
              replication stream in its SQLite. That is an RDB from a full sync, then the effects of every write.
            </>,
            <>
              After each batch of client commands, it appends <code>ROLE</code>. The reply carries the server's
              replication offset. The batch's replies leave once the stream up to that offset is stored.
            </>,
            <>
              The output gate holds those replies until the storage write commits, as for a wasm shard (
              <DocLink slug="durability">durability</DocLink>).
            </>,
          ]}
        />
        <Checklist items={["An acknowledged write is in the object's storage.", "No read sees a write that isn't."]} />
        <p>
          The container's memory can go at any moment. The server runs with <strong>no persistence</strong> of its own.
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
            <>The server loads the RDB. The stream stored since then replays into it as plain commands.</>,
            <>
              The object becomes the server's replica again. It continues from the server's own history and offset, with{" "}
              <strong>no second copy</strong>.
            </>,
          ]}
        />
        <ul>
          <li>
            A restored server holds exactly what's stored. The object only notes where the server's offsets line up with
            its stored stream.
          </li>
          <li>A full sync happens only if the server refuses to continue.</li>
          <li>
            An idle shard folds its stream into a fresh base before it stops, so it wakes with{" "}
            <strong>nothing to replay</strong>.
          </li>
          <li>
            A burst of new shards can outrun the instances the platform has ready. A boot waits up to{" "}
            <strong>3 minutes</strong> for one.
          </li>
        </ul>
        <h3>When only the object restarts</h3>
        <ul>
          <li>The object restarts on every deploy, for example. Its server can keep running meanwhile.</li>
          <li>
            A server that kept running is kept if it answers and can continue the stored stream from its last byte.
          </li>
          <li>
            A server whose copy or replay was cut short can't. Its container is destroyed, and the shard restores into a
            new one.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "generations",
    title: "How the stored stream stays small",
    content: (
      <>
        <GenerationsDiagram />
        <ul>
          <li>
            Once the stored stream outgrows its base (<strong>64 MB</strong> at least), a second replica link takes a
            fresh RDB. The first link keeps storing meanwhile.
          </li>
          <li>The new generation takes over only once it holds everything the old one does.</li>
          <li>
            So storage stays near <strong>two bases</strong>, and a restore replays at most one base's worth of stream.
          </li>
          <li>
            The old generation is then deleted <strong>8 MB at a time</strong>, with client traffic running in between.
            One delete of it all would hold every reply until it committed.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "connections",
    title: "Connections",
    content: (
      <>
        <ul>
          <li>
            Each client connection gets a socket per shard, as with wasm shards. It is proxied to a server connection of
            its own and fenced the same way.
          </li>
          <li>
            Past an isolate's socket budget, batches go over RPC. They share one pipelined server connection per shard.
          </li>
          <li>Transactions, pub/sub and blocking commands always get a socket.</li>
        </ul>
        <h3>Pub/sub</h3>
        <ul>
          <li>Pub/sub runs on shard 0's server. A container of its own would idle at full price.</li>
          <li>
            When that shard restarts, its subscribers are disconnected. Clients such as ioredis reconnect and subscribe
            again.
          </li>
          <li>Messages published in between are lost.</li>
        </ul>
        <Note>
          <p>
            Any one client connection is one Worker invocation, and every RPC call to a shard is a subrequest. The
            Worker raises its subrequest limit to <strong>10 million</strong> so a busy connection isn't cut off at the
            default 10,000.
          </p>
        </Note>
      </>
    ),
  },
];
