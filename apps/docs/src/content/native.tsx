import { ShippingContainerIcon } from "@phosphor-icons/react";
import { Code, Note, Steps, Table } from "../components/blocks";
import { DocLink } from "../components/doc-link";
import { NATIVE_RUN_SECTIONS } from "./native-ops";
import { server, source } from "./sources";
import type { Doc } from "./types";

export const native: Doc = {
  slug: "native",
  title: "Native Redis in containers",
  navTitle: "Native Redis",
  group: "Run it",
  icon: ShippingContainerIcon,
  description:
    "An experimental third flavour: unmodified Redis 8.12.0 in a Cloudflare Container, one per shard, with each shard's Durable Object as its only durable copy. A shard holds 2 GB instead of 64 MB.",
  keywords:
    "redis-native native redis container containers VADO_CONTAINERS box compaction restore netcat scheduling durable_object BOX_MAXMEMORY",
  intro: (
    <p>
      The <code>redis-native</code> flavour runs the Redis server as released, built from the same pinned tarball as the
      wasm build, in a container next to each shard's Durable Object. The router, catalog, AUTH and dashboard are the
      same code as for the wasm flavours. It is opt-in at build time and runs on a platform feature in beta.
    </p>
  ),
  sections: [
    {
      id: "choosing",
      title: "Choosing it",
      content: (
        <Table
          headers={["", "Valkey or Redis in wasm", "Native Redis"]}
          rows={[
            ["Data per shard", "64 MB", "2 GB by default"],
            ["Where the server runs", "Inside the shard's object", "In a container where the object runs"],
            ["Read replicas", "Yes", "No"],
            ["While idle", "The object sleeps, at no cost", "The container stops after 10 minutes without clients"],
            ["First command after sleeping", "0.2-0.8 s", "2-15 s: the container restores from storage"],
            ["Platform", "Durable Objects", "Containers, durable_object scheduling (beta)"],
          ]}
        />
      ),
    },
    {
      id: "enabling",
      title: "Enabling it",
      content: (
        <>
          <Code label="Terminal">{"VADO_CONTAINERS=1 npm run deploy"}</Code>
          <p>
            The build adds a container application for <code>RedisBox</code>, and Docker builds{" "}
            <code>packages/box/redis/Dockerfile</code> during the deploy. To skip the build, set{" "}
            <code>VADO_REDIS_IMAGE</code> to a digest-pinned image you pushed to the Cloudflare registry with{" "}
            <code>wrangler containers push</code>. A deploy without <code>VADO_CONTAINERS=1</code> has no container
            application, and the flavour isn't offered.
          </p>
          <Code label="Terminal">
            {'curl -H "authorization: Bearer $BENCH_TOKEN" "https://<worker>/db?db=big&shards=16&flavour=redis-native"'}
          </Code>
          <p>
            A database is native from creation, through the bench API or the dashboard; a database made by its first
            AUTH runs Valkey. <code>BOX_MAXMEMORY</code> sets Redis's <code>maxmemory</code> (default <code>2gb</code>,
            on a <code>standard-1</code> instance with 4 GiB). <code>VADO_CONTAINER_APP</code> names the container
            application, for two vado Workers on one account.
          </p>
        </>
      ),
    },
    {
      id: "durability",
      title: "How a shard stays durable",
      content: (
        <>
          <Steps
            items={[
              <>
                The shard's object is a Redis replica. It stores Redis's replication stream in its SQLite: an RDB from a
                full sync, then the effects of every write.
              </>,
              <>
                After each batch of client commands it appends <code>ROLE</code>, whose reply carries Redis's
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
            memory can go at any moment: Redis runs with no persistence of its own.
          </p>
        </>
      ),
    },
    {
      id: "restore",
      title: "Restores and compaction",
      content: (
        <>
          <p>A stopped or lost container comes back on the next command:</p>
          <Steps
            items={[
              <>A new container starts with Redis held back behind a gate file.</>,
              <>
                The stored RDB streams in over TCP to netcat, and its size is checked against storage: 0.7 s for 170 MB
                at the median, where <code>exec()</code> managed 13 MB/s.
              </>,
              <>Redis loads the RDB, then the stored stream replays into it as plain commands.</>,
              <>
                A fresh full sync becomes the next generation of storage, and the old one is deleted in the same
                transaction.
              </>,
            ]}
          />
          <p>
            A container found running without a finished restore is destroyed rather than synced, since its partial copy
            would become the next generation. A burst of new shards can outrun the instances the platform has ready; a
            boot waits up to 3 minutes for one, and a broken copy is retried on a new container.
          </p>
          <p>
            Once the stored stream outgrows its base (64 MB at least), a second replica link takes a fresh RDB while the
            first keeps storing. The new generation takes over only once it holds everything the old one does. So
            storage stays near two bases, and a restore replays at most one.
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
            Each client connection gets a socket per shard, as with wasm shards, proxied to a Redis connection of its
            own and fenced the same way. Past an isolate's socket budget, batches go over RPC and share one pipelined
            Redis connection per shard. Transactions, pub/sub and blocking commands always get a socket.
          </p>
          <p>
            Pub/sub runs on shard 0's Redis: a container of its own would idle at full price. When that shard restarts,
            its subscribers are disconnected, and clients such as ioredis reconnect and subscribe again. Messages
            published in between are lost, as with Redis.
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
    ...NATIVE_RUN_SECTIONS,
  ],
  sources: [
    server("box/box.ts"),
    server("box/engine.ts"),
    server("box/link.ts"),
    server("box/redis.ts"),
    source("packages/box/redis/Dockerfile"),
    source("packages/box/README.md"),
  ],
};
