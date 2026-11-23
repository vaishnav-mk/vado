import { useState } from "react";
import { DocLink } from "../doc-link";
import { EDGES, NODES, PHASES } from "./architecture-data";

export function ArchitectureDiagram() {
  const [phase, setPhase] = useState(0);
  const active = PHASES[phase];
  const hot = (id: string) => active.nodes.includes(id);

  return (
    <figure className="diagram-card">
      <div className="diagram-top">
        <span className="status">One database, end to end</span>
        <span className="max-md:hidden">Click a box to read about it</span>
        <span className="md:hidden">Swipe to explore</span>
      </div>
      <div className="diagram-scroll">
        <svg className="architecture-svg" viewBox="0 0 792 326" role="group" aria-labelledby="arch-title arch-desc">
          <title id="arch-title">How a client reaches a vado database</title>
          <desc id="arch-desc">
            Clients connect over TCP, a WebSocket or a service binding to a router in the Worker. The router reads the
            catalog, sends commands to shard Durable Objects running Valkey with its AOF in SQLite, and reads from
            replicas in other regions. Rewriters compact each shard's AOF. A Watcher polls shards and replicas for the
            dashboard.
          </desc>
          {EDGES.map((edge) => (
            <path
              key={`${edge.from}-${edge.to}`}
              className="edge"
              d={edge.d}
              data-hot={hot(edge.from) && hot(edge.to)}
            />
          ))}
          {NODES.map((node) => (
            <DocLink key={node.id} slug="architecture" hash={node.section} className="node-link">
              <g data-hot={hot(node.id)}>
                <rect className="node-box" x={node.x} y={node.y} width={node.w} height={node.h} rx="9" />
                <text className="node-title" x={node.x + 13} y={node.y + 24}>
                  {node.title}
                </text>
                <text className="node-sub" x={node.x + 13} y={node.y + 42}>
                  {node.sub}
                </text>
              </g>
            </DocLink>
          ))}
        </svg>
      </div>
      <div className="diagram-tabs" role="group" aria-label="Highlight a path">
        {PHASES.map((item, index) => (
          <button key={item.title} type="button" aria-pressed={index === phase} onClick={() => setPhase(index)}>
            {item.title}
          </button>
        ))}
      </div>
      <figcaption className="diagram-caption" aria-live="polite">
        {active.caption}
      </figcaption>
      <div className="diagram-legend">
        <span>
          <i className="line-key" />
          Selected path
        </span>
        <span>
          <i className="line-key gray" />
          Other calls
        </span>
        <span>Responsibilities, not machines</span>
      </div>
    </figure>
  );
}
