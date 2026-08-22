const AGENTS = [
  {
    name: "Claude Code",
    role: "implementer · its own governed worktree",
    y: 92,
    tone: "var(--trust-human)",
  },
  {
    name: "Codex",
    role: "implementer · its own governed worktree",
    y: 172,
    tone: "var(--trust-human)",
  },
  {
    name: "Cursor",
    role: "read-only · reads the workspace, cannot change it",
    y: 252,
    tone: "var(--trust-crew)",
  },
  {
    name: "OpenCode",
    role: "read-only · reads the workspace, cannot change it",
    y: 332,
    tone: "var(--trust-crew)",
  },
];

const MEMORY_NODES = [
  { x: 760, y: 96, r: 7, tone: "var(--trust-human)" },
  { x: 838, y: 140, r: 5, tone: "var(--trust-crew)" },
  { x: 706, y: 168, r: 5, tone: "var(--trust-crew)" },
  { x: 800, y: 212, r: 8, tone: "var(--trust-human)" },
  { x: 872, y: 262, r: 5, tone: "var(--trust-stale)" },
  { x: 744, y: 268, r: 6, tone: "var(--trust-crew)" },
  { x: 812, y: 330, r: 5, tone: "var(--trust-stale)" },
];

const MEMORY_EDGES: [number, number][] = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 3],
  [3, 4],
  [3, 5],
  [5, 6],
];

export function CoordinationDiagram() {
  return (
    <div className="panel rack-grid p-3 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <span className="panel-label">How a mission runs</span>
        <div className="flex flex-wrap items-center gap-4 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-trust-human" /> Confirmed
          </span>
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-trust-crew" /> Shared by the crew
          </span>
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-trust-stale" /> Unconfirmed — waiting on you
          </span>
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-trust-unconfirmed" /> Rejected — kept for
            provenance
          </span>
        </div>
      </div>

      <svg
        viewBox="0 0 960 420"
        className="h-auto w-full"
        role="img"
        aria-label="Diagram: one mission is split into jobs across Claude Code, Codex, Cursor and OpenCode, all reading and writing one shared memory, with a human approval before anything ships."
      >
        <defs>
          <marker id="mn-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill="oklch(1 0 0 / 35%)" />
          </marker>
        </defs>

        {/* column captions */}
        <text
          x="30"
          y="34"
          fill="oklch(0.65 0.005 285)"
          fontSize="11"
          fontFamily="JetBrains Mono, monospace"
          letterSpacing="1.6"
        >
          1 · YOUR MISSION
        </text>
        <text
          x="360"
          y="34"
          fill="oklch(0.65 0.005 285)"
          fontSize="11"
          fontFamily="JetBrains Mono, monospace"
          letterSpacing="1.6"
        >
          2 · THE CREW, ON CLEAR JOBS
        </text>
        <text
          x="700"
          y="34"
          fill="oklch(0.65 0.005 285)"
          fontSize="11"
          fontFamily="JetBrains Mono, monospace"
          letterSpacing="1.6"
        >
          3 · SHARED MEMORY
        </text>

        {/* mission card */}
        <g>
          <rect
            x="30"
            y="170"
            width="212"
            height="86"
            fill="color-mix(in oklab, var(--muon-blue) 14%, transparent)"
            stroke="var(--muon-blue)"
          />
          <text
            x="46"
            y="198"
            fill="oklch(0.92 0.004 285)"
            fontSize="14"
            fontFamily="JetBrains Mono, monospace"
          >
            “Ship checkout v2”
          </text>
          <text
            x="46"
            y="222"
            fill="oklch(0.65 0.005 285)"
            fontSize="11"
            fontFamily="Work Sans, sans-serif"
          >
            One goal in. MUON plans the
          </text>
          <text
            x="46"
            y="238"
            fill="oklch(0.65 0.005 285)"
            fontSize="11"
            fontFamily="Work Sans, sans-serif"
          >
            jobs, owners and limits.
          </text>
        </g>

        {/* mission -> agents */}
        {AGENTS.map((a) => (
          <path
            key={`link-${a.name}`}
            d={`M242 213 C 300 213, 300 ${a.y + 26}, 358 ${a.y + 26}`}
            fill="none"
            stroke="oklch(1 0 0 / 22%)"
            strokeWidth="1"
            markerEnd="url(#mn-arrow)"
          />
        ))}

        {/* agents */}
        {AGENTS.map((a) => (
          <g key={a.name}>
            <rect
              x="358"
              y={a.y}
              width="240"
              height="52"
              fill="oklch(1 0 0 / 3%)"
              stroke="oklch(1 0 0 / 12%)"
            />
            <rect x="358" y={a.y} width="3" height="52" fill={a.tone} />
            <text
              x="376"
              y={a.y + 22}
              fill="oklch(0.92 0.004 285)"
              fontSize="13"
              fontFamily="JetBrains Mono, monospace"
            >
              {a.name}
            </text>
            <text
              x="376"
              y={a.y + 40}
              fill="oklch(0.65 0.005 285)"
              fontSize="11"
              fontFamily="Work Sans, sans-serif"
            >
              {a.role}
            </text>
            {/* agent <-> memory */}
            <path
              d={`M598 ${a.y + 26} C 650 ${a.y + 26}, 660 214, 700 214`}
              fill="none"
              stroke={a.tone}
              strokeOpacity="0.5"
              strokeWidth="1"
              className="animate-edge-dash"
            />
          </g>
        ))}

        {/* memory cluster */}
        <circle cx="800" cy="214" r="130" fill="oklch(1 0 0 / 2.5%)" stroke="oklch(1 0 0 / 10%)" />
        {MEMORY_EDGES.map(([a, b]) => (
          <line
            key={`me-${a}-${b}`}
            x1={MEMORY_NODES[a]!.x}
            y1={MEMORY_NODES[a]!.y}
            x2={MEMORY_NODES[b]!.x}
            y2={MEMORY_NODES[b]!.y}
            stroke="oklch(1 0 0 / 20%)"
            strokeWidth="1"
          />
        ))}
        {MEMORY_NODES.map((n, i) => (
          <g key={`mn-${i}`}>
            <circle cx={n.x} cy={n.y} r={n.r + 6} fill={n.tone} opacity="0.14" />
            <circle cx={n.x} cy={n.y} r={n.r} fill={n.tone} />
          </g>
        ))}
        <text
          x="700"
          y="372"
          fill="oklch(0.65 0.005 285)"
          fontSize="11"
          fontFamily="Work Sans, sans-serif"
        >
          Decisions, results and open questions,
        </text>
        <text
          x="700"
          y="388"
          fill="oklch(0.65 0.005 285)"
          fontSize="11"
          fontFamily="Work Sans, sans-serif"
        >
          read by the crew before the next move.
        </text>
      </svg>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          4 · Nothing ships until a person says yes
        </span>
        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-trust-stale">
          <span className="animate-gate-pulse size-1.5 rounded-full bg-trust-stale" />
          Your review, then it merges
        </span>
      </div>
    </div>
  );
}
