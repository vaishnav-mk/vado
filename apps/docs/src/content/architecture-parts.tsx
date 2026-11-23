import type { DocSection } from "./types";

interface Part {
  id: string;
  title: string;
  meta: string;
  owns: string;
  why: string;
  helps: string;
  cost: string;
}

const PARTS: Part[] = [
  {
    id: "clients",
    title: "How clients reach it",
    meta: "Spectrum · /ws · service binding",
    owns: "Three ways in, all ending at the same router: raw TCP through a Spectrum application, RESP over the /ws WebSocket, or connect() from another Worker.",
    why: "A Worker's public URL takes HTTP, not raw TCP. Spectrum, where your plan includes Worker origins, carries TCP to it, and the shim carries any client over a WebSocket.",
    helps: "Stock clients work unchanged on every path. A service binding never leaves Cloudflare.",
    cost: "A WebSocket can't push back on its sender. A client that outruns its router by 16 MB is disconnected, and the shim acknowledges what it has read so the router stops past 8 MB unread.",
  },
  {
    id: "router",
    title: "Router",
    meta: "Worker · one per client connection",
    owns: "One connection: parsing, AUTH, the selected database, MULTI and WATCH state, and an upstream per shard and replica it has used.",
    why: "Clients expect one server. Redirecting between shards would need cluster-aware clients.",
    helps:
      "Single-slot commands pass through unchanged and pipelined. Multi-key commands that are safe to split are split and merged in order; whole-database commands go to every shard.",
    cost: "One more hop than talking to a shard. Other multi-key commands across slots get CROSSSLOT.",
  },
  {
    id: "shards",
    title: "Shards",
    meta: "ValkeyShard to ValkeyShard7 · <db>.<created>.<i>",
    owns: "A contiguous range of the 16,384 slots, in a Valkey 9.1 server compiled to wasm, with its AOF in the object's SQLite.",
    why: "Running Valkey's code keeps every reply, error and edge case Valkey's own.",
    helps:
      "With appendfsync always and a write-through file system, a reply leaves only after its write is stored. A reset shard replays its AOF and carries on.",
    cost: "Data lives in Valkey's memory: at most 64 MB per shard inside a 128 MB memory limit, and wasm memory never shrinks.",
  },
  {
    id: "replicas",
    title: "Read replicas",
    meta: "ValkeyShard8 to ValkeyShard15 · <shard>.r.<region>",
    owns: "A copy of one shard in one region, in memory only.",
    why: "A shard lives in one place, so a far client pays that distance on every read, and a primary's replies also wait for its commits.",
    helps:
      "The primary sends its AOF files as a starting copy, then every committed append. Routers read from the replica in their region, which has no commits to wait for.",
    cost: "A read on another connection can be one replication lag old. Each replica's stream holds back the primary's writes.",
  },
  {
    id: "rewriters",
    title: "Rewriters",
    meta: "ValkeyRewriter to ValkeyRewriter7 · named like their shard",
    owns: "One AOF rewrite at a time for one shard, in a Valkey of its own.",
    why: "Valkey compacts its AOF in a forked child. wasm has no fork(), so a rewrite inside the shard would block it.",
    helps:
      "The rewriter loads a copy of the files, rewrites, and sends back a new base. The shard keeps serving and swaps it in.",
    cost: "Each rewrite copies the files to another object and the base back. After a rewriter fails, the shard rewrites inline for 10 minutes.",
  },
  {
    id: "catalog",
    title: "Catalog",
    meta: "Catalog · one object named catalog",
    owns: "Every database's name, creation time, shard count, regions, replica regions, flavour and password hash.",
    why: "Routing must be computed, not looked up per command, and a shard count must never change under existing keys.",
    helps: "A record never changes after creation, so each Worker process fetches it once and keeps it.",
    cost: "No online resharding or moving. A different size or placement means a new database.",
  },
  {
    id: "watcher",
    title: "Watcher, Pulse and the dashboard",
    meta: "Watcher · Pulse · apps/dashboard",
    owns: "The Watcher keeps five minutes of history for one watched database. Pulse holds each router process's latest report of its open connections.",
    why: "Routers run in many places and share nothing, so something has to collect what the dashboard shows.",
    helps:
      "The Watcher polls shards and ready replicas once a second while anyone has /live open, and stops when nobody does.",
    cost: "Both keep everything in memory, so a reset loses the history. Each watched database costs a poll of every shard and replica a second.",
  },
];

export const PART_SECTIONS: DocSection[] = PARTS.map((part) => ({
  id: part.id,
  title: part.title,
  content: (
    <div className="service">
      <p className="service-meta">{part.meta}</p>
      <dl>
        <dt>Owns</dt>
        <dd>{part.owns}</dd>
        <dt>Why</dt>
        <dd>{part.why}</dd>
        <dt>How it helps</dt>
        <dd>{part.helps}</dd>
        <dt>Trade-off</dt>
        <dd>{part.cost}</dd>
      </dl>
    </div>
  ),
}));
