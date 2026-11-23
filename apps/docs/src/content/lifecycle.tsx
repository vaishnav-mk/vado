import { PathIcon } from "@phosphor-icons/react";
import { Table } from "../components/blocks";
import { server } from "./sources";
import type { Doc } from "./types";

const STEPS = [
  {
    where: "Client → Worker",
    title: "Connect",
    text: "Spectrum, a service binding's connect(), or /ws hands the Worker a socket, and it starts a router. Through a binding, the dialed host names the database.",
  },
  {
    where: "Router",
    title: "AUTH",
    text: "With VALKEY_PASSWORD set, only AUTH, HELLO and QUIT run until the client signs in, and requests are capped at 64 KB. The username picks the database; its record comes from the catalog once per process.",
  },
  {
    where: "Router",
    title: "Parse",
    text: "The router cuts one RESP request from the buffered bytes. A request over about 8 MB gets Valkey's protocol error and the connection closes.",
  },
  {
    where: "Router",
    title: "Route",
    text: "Valkey's COMMAND table gives the key positions. Each key hashes to a slot, and the slot to a shard. One slot: the bytes go unchanged to that shard, or a nearby replica for a read.",
  },
  {
    where: "Shard",
    title: "Run and store",
    text: "The shard feeds the bytes to Valkey and runs one pass of its event loop. Valkey executes SET and appends it to its AOF, which the file system writes to SQLite. The output gate holds the reply until that commit.",
  },
  {
    where: "Shard → replicas",
    title: "Replicate",
    text: "Once committed, the same AOF bytes go to each of the shard's replicas, which run them as commands.",
  },
  {
    where: "Router → client",
    title: "Reply",
    text: "The router matches the reply to its request and writes replies in request order, batching every reply ready at once into one write.",
  },
];

export const lifecycle: Doc = {
  slug: "lifecycle",
  title: "Life of a request",
  group: "How it works",
  icon: PathIcon,
  description: "What happens between a client sending SET k v and reading +OK, and what each reply tells you.",
  keywords: "lifecycle request walkthrough SET connect auth parse route reply errors LOST EXEC null CROSSSLOT",
  sections: [
    {
      id: "set",
      title: "One SET, step by step",
      content: (
        <ol className="timeline">
          {STEPS.map((step) => (
            <li key={step.title}>
              <span className="step-location">{step.where}</span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
      ),
    },
    {
      id: "replies",
      title: "What a reply tells you",
      content: (
        <Table
          headers={["You see", "It means"]}
          rows={[
            [
              "A normal reply to a write",
              "The write is committed to the shard's SQLite. It survives resets and deploys.",
            ],
            [
              <code>ERR shard connection lost; the command may or may not have run</code>,
              "The shard reset with the command in flight. Retry only if it is safe to repeat.",
            ],
            [
              "A read succeeds after a reset",
              "The router retried it once, on a fresh connection or on the primary. Writes are never retried.",
            ],
            ["EXEC returns a null reply", "A watched key's shard reset, so the transaction didn't run."],
            [
              "A read misses another connection's write",
              "It went to a replica that hadn't run the write yet. Use WAIT on the writer if that matters.",
            ],
            [
              "Replies from one shard slow by up to about 150 ms",
              "A rewriter is compacting that shard's AOF, for a few seconds.",
            ],
            [
              "One shard pauses for a second or two",
              "It is rewriting inline, which blocks it. That happens for 10 minutes after a rewriter fails.",
            ],
            [<code>CROSSSLOT</code>, "The command needs its keys in one slot. Use a {hashtag}."],
            [
              "The connection closes",
              "A protocol error or size limit (an error comes first), a WebSocket client that sent too fast, or the Worker restarting.",
            ],
          ]}
        />
      ),
    },
  ],
  sources: [
    server("router/serve.ts"),
    server("router/auth.ts"),
    server("protocol/request.ts"),
    server("router/routing.ts"),
    server("router/replies.ts"),
    server("shard/host/loop.ts"),
  ],
};
