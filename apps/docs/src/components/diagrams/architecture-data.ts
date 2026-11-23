export interface Phase {
  title: string;
  nodes: string[];
  caption: string;
}

export interface DiagramNode {
  id: string;
  title: string;
  sub: string;
  x: number;
  y: number;
  w: number;
  h: number;
  section: string;
}

export interface Edge {
  from: string;
  to: string;
  d: string;
}

export const PHASES: Phase[] = [
  {
    title: "Connect",
    nodes: ["tcp", "ws", "binding", "router", "catalog"],
    caption:
      "A client arrives over TCP through Spectrum, over the /ws WebSocket through vado-shim, or from another Worker through a service binding. Each connection gets its own router. AUTH names the database, and the router reads its shard count and placement from the catalog once, then keeps it.",
  },
  {
    title: "Write",
    nodes: ["tcp", "router", "shards", "replicas", "rewriter"],
    caption:
      "SET hashes its key to one of 16,384 slots and goes to the shard that owns it. Valkey appends the command to its AOF, the file system stores it in SQLite, and the reply leaves only after that commit. The committed bytes then stream to the replicas. When the AOF grows, a rewriter compacts it.",
  },
  {
    title: "Read a replica",
    nodes: ["tcp", "router", "replicas"],
    caption:
      "A read-only GET from a connection with no recent write to that shard goes to the replica in the router's region, or a neighbouring one. A replica keeps its copy in memory and has no storage commit to wait for.",
  },
  {
    title: "Restart",
    nodes: ["router", "shards", "replicas"],
    caption:
      "On a deploy, a busy shard stops reading, answers what it has read, waits for those writes to commit and tells each router. The routers resend everything still unanswered to the new copy, in order. Replicas keep serving meanwhile.",
  },
  {
    title: "Watch",
    nodes: ["watcher", "shards", "replicas"],
    caption:
      "While someone has the dashboard open, the database's Watcher polls every shard and ready replica once a second and streams the numbers to the page. Nobody watching means no polling.",
  },
];

export const NODES: DiagramNode[] = [
  { id: "tcp", title: "valkey-cli, ioredis", sub: "TCP via Spectrum", x: 16, y: 40, w: 150, h: 56, section: "clients" },
  { id: "ws", title: "vado-shim", sub: "WebSocket /ws", x: 16, y: 142, w: 150, h: 56, section: "clients" },
  { id: "binding", title: "Your Worker", sub: "service binding", x: 16, y: 244, w: 150, h: 56, section: "clients" },
  { id: "router", title: "Router", sub: "one per connection", x: 214, y: 140, w: 150, h: 60, section: "router" },
  { id: "catalog", title: "Catalog", sub: "databases, placement", x: 214, y: 20, w: 150, h: 56, section: "catalog" },
  { id: "shards", title: "Shards", sub: "wasm server + AOF", x: 420, y: 140, w: 150, h: 60, section: "shards" },
  { id: "rewriter", title: "Rewriters", sub: "AOF compaction", x: 420, y: 250, w: 150, h: 56, section: "rewriters" },
  { id: "replicas", title: "Read replicas", sub: "other regions", x: 626, y: 140, w: 150, h: 60, section: "replicas" },
  { id: "watcher", title: "Watcher", sub: "dashboard, /live", x: 626, y: 250, w: 150, h: 56, section: "watcher" },
];

export const EDGES: Edge[] = [
  { from: "tcp", to: "router", d: "M166 68H190V160H214" },
  { from: "ws", to: "router", d: "M166 170H214" },
  { from: "binding", to: "router", d: "M166 272H190V180H214" },
  { from: "router", to: "catalog", d: "M289 140V76" },
  { from: "router", to: "shards", d: "M364 170H420" },
  { from: "router", to: "replicas", d: "M340 140V110H701V140" },
  { from: "shards", to: "replicas", d: "M570 160H626" },
  { from: "shards", to: "rewriter", d: "M495 200V250" },
  { from: "watcher", to: "shards", d: "M626 278H598V188H570" },
  { from: "watcher", to: "replicas", d: "M701 250V200" },
];
