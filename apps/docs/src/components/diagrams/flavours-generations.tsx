interface Bar {
  x: number;
  w: number;
  label: string;
  /** Part of the current generation, the one a restore uses. */
  current?: boolean;
  deleting?: boolean;
}

const ROWS: { title: string; y: number; bars: Bar[] }[] = [
  {
    title: "Generation 1",
    y: 44,
    bars: [
      { x: 120, w: 106, label: "Base RDB", current: true },
      { x: 230, w: 330, label: "Stream: every write since the base", current: true },
      { x: 564, w: 212, label: "Deleted, 8 MB at a time", deleting: true },
    ],
  },
  {
    title: "Generation 2",
    y: 124,
    bars: [
      { x: 330, w: 126, label: "Fresh RDB" },
      { x: 460, w: 100, label: "Catching up" },
      { x: 564, w: 212, label: "Current generation", current: true },
    ],
  },
];

const MARKS: { x: number; lines: [string, string] }[] = [
  { x: 330, lines: ["Stream outgrows its base,", "64 MB at least"] },
  { x: 562, lines: ["Generation 2 holds everything", "generation 1 does, and takes over"] },
];

export function GenerationsDiagram() {
  return (
    <figure className="diagram-card">
      <div className="diagram-top">
        <span className="status">One container shard's storage</span>
        <span className="max-md:hidden">Time runs left to right</span>
      </div>
      <div className="diagram-scroll">
        <svg
          className="architecture-svg"
          viewBox="0 0 792 214"
          role="img"
          aria-labelledby="flavours-gen-title flavours-gen-desc"
        >
          <title id="flavours-gen-title">How a container shard stores its replication stream in generations</title>
          <desc id="flavours-gen-desc">
            Generation 1 is a base RDB and the stream of every write since it. Once the stream outgrows its base, 64 MB
            at least, a second replica link takes a fresh RDB for generation 2 while the first keeps storing. Generation
            2 catches up, and once it holds everything generation 1 does, it takes over as the current generation.
            Generation 1 is then deleted 8 MB at a time.
          </desc>
          {MARKS.map((mark) => (
            <g key={mark.x}>
              <path className="edge" d={`M${mark.x} 34 V174`} strokeDasharray="3 4" />
              {mark.lines.map((line, index) => (
                <text key={line} x={mark.x + 6} y={190 + index * 14}>
                  {line}
                </text>
              ))}
            </g>
          ))}
          {ROWS.map((row) => (
            <g key={row.title}>
              <text className="node-title" x="16" y={row.y + 25}>
                {row.title}
              </text>
              {row.bars.map((bar) => (
                <g key={bar.label} data-hot={bar.current === true}>
                  <rect
                    className="node-box"
                    x={bar.x}
                    y={row.y}
                    width={bar.w}
                    height="40"
                    rx="7"
                    strokeDasharray={bar.deleting === true ? "5 4" : undefined}
                  />
                  <text x={bar.x + 12} y={row.y + 25}>
                    {bar.label}
                  </text>
                </g>
              ))}
            </g>
          ))}
        </svg>
      </div>
      <div className="diagram-legend">
        <span>
          <i className="origin-key" data-origin="ours" />
          The current generation. A restore loads its base, then replays its stream
        </span>
      </div>
    </figure>
  );
}
