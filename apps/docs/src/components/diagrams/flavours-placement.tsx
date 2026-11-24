import type { CSSProperties } from "react";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub: string;
  server?: boolean;
  dashed?: boolean;
}

// The server's boxes take the colour of the server picked in the header.
const SERVER_STYLE: CSSProperties = { fill: "var(--server-tint)", stroke: "var(--server-ink)" };

const BOXES: Box[] = [
  { x: 16, y: 136, w: 104, h: 56, title: "Client", sub: "AUTH picks a db" },
  { x: 150, y: 136, w: 134, h: 56, title: "Router", sub: "same for all four" },
  { x: 320, y: 32, w: 456, h: 112, title: "Shard Durable Object", sub: "its SQLite holds the server's AOF" },
  {
    x: 334,
    y: 84,
    w: 428,
    h: 48,
    title: "valkey.wasm or redis.wasm",
    sub: "the server, compiled to wasm, 64 MB of data",
    server: true,
  },
  { x: 320, y: 186, w: 200, h: 112, title: "Shard Durable Object", sub: "a replica of the server" },
  { x: 334, y: 238, w: 172, h: 48, title: "Its SQLite", sub: "the replication stream" },
  { x: 588, y: 186, w: 188, h: 112, title: "Container", sub: "no persistence of its own", dashed: true },
  { x: 600, y: 238, w: 164, h: 48, title: "Valkey or Redis", sub: "as released, 2 GB", server: true },
];

const EDGES = ["M120 164 H150", "M284 164 C302 164 302 88 320 88", "M284 164 C302 164 302 242 320 242"];

export function PlacementDiagram() {
  return (
    <figure className="diagram-card">
      <div className="diagram-top">
        <span className="status">Where the server runs</span>
        <span className="max-md:hidden">Two flavours inside the object, two beside it</span>
      </div>
      <div className="diagram-scroll">
        <svg
          className="architecture-svg"
          viewBox="0 0 792 316"
          role="img"
          aria-labelledby="flavours-place-title flavours-place-desc"
        >
          <title id="flavours-place-title">Where each flavour's server runs</title>
          <desc id="flavours-place-desc">
            A client reaches the router, which is the same for all four flavours. For valkey and redis, the router talks
            to a shard Durable Object that runs valkey.wasm or redis.wasm inside it, with the server's AOF in the
            object's SQLite. For valkey-native and redis-native, the router talks to a shard Durable Object that is a
            replica of the server and stores its replication stream in SQLite. The server runs as released in a
            container beside the object, with no persistence of its own.
          </desc>
          <text x="320" y="22">
            valkey and redis run the server inside the object
          </text>
          <text x="320" y="176">
            valkey-native and redis-native run it in a container beside the object
          </text>
          {EDGES.map((d) => (
            <path key={d} className="edge" d={d} />
          ))}
          <path className="edge" d="M520 246 H588" />
          <path className="edge" d="M520 266 H588" />
          <text x="554" y="240" textAnchor="middle">
            commands
          </text>
          <text x="554" y="282" textAnchor="middle">
            stream
          </text>
          {BOXES.map((box) => (
            <g key={`${box.x}-${box.y}`}>
              <rect
                className="node-box"
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                rx="9"
                style={box.server === true ? SERVER_STYLE : undefined}
                strokeDasharray={box.dashed === true ? "5 4" : undefined}
              />
              <text className="node-title" x={box.x + 14} y={box.y + 22}>
                {box.title}
              </text>
              <text className="node-sub" x={box.x + 14} y={box.y + 39}>
                {box.sub}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="diagram-legend">
        <span>
          <i className="origin-key" data-origin="upstream" />
          The server, Valkey or Redis
        </span>
        <span>
          <i className="line-key gray" />
          Calls between parts
        </span>
        <span>Responsibilities, not machines</span>
      </div>
    </figure>
  );
}
