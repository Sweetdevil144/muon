const NODES = [
  { id: "n1", x: 90, y: 70, r: 9, tone: "var(--trust-human)", label: "How checkout auth works" },
  { id: "n2", x: 270, y: 40, r: 7, tone: "var(--trust-crew)", label: "Who owns the queue" },
  { id: "n3", x: 400, y: 96, r: 8, tone: "var(--trust-human)", label: "Refund rule" },
  { id: "n4", x: 175, y: 175, r: 7, tone: "var(--trust-stale)", label: "Old retry approach" },
  { id: "n5", x: 330, y: 205, r: 6, tone: "var(--trust-stale)", label: "Proposed by Codex" },
  { id: "n6", x: 455, y: 160, r: 7, tone: "var(--trust-crew)", label: "Fixtures changed" },
  {
    id: "n7",
    x: 60,
    y: 205,
    r: 5,
    tone: "var(--trust-unconfirmed)",
    label: "Rejected by you — kept",
  },
];

const EDGES = [
  ["n1", "n2"],
  ["n2", "n3"],
  ["n1", "n4"],
  ["n4", "n5"],
  ["n3", "n6"],
  ["n5", "n6"],
  ["n4", "n7"],
];

const REVIEW = [
  {
    tone: "text-trust-stale",
    dot: "bg-trust-stale",
    agent: "Codex proposes — unconfirmed",
    text: "Retries are safe to repeat above the dispatcher.",
    path: "src/queue/dispatch.ts",
  },
  {
    tone: "text-trust-stale",
    dot: "bg-trust-stale",
    agent: "Superseded",
    text: "“Sessions expire in 24h” — this file changed 11 days ago.",
    path: "src/auth/session.ts",
  },
  {
    tone: "text-trust-crew",
    dot: "bg-trust-crew",
    agent: "Corroborated by 2 crew lanes",
    text: "The webhook signer is shared across services. Evidence, not confirmation.",
    path: "src/api/webhook.ts",
  },
];

export function SharedMemory() {
  return (
    <section id="memory" className="border-t border-border py-20 lg:py-28">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="panel-label mb-3">Shared memory</p>
          <h2 className="max-w-[26ch] font-sans text-[1.75rem] font-semibold tracking-[-0.02em] lg:text-4xl">
            Every decision your agents make, in one place they all read.
          </h2>
        </div>
        <p className="max-w-[46ch] text-[0.9375rem] leading-relaxed text-muted-foreground">
          Agents check what the crew already learned before they edit, and write back what they
          find. Nothing becomes lasting knowledge until a person confirms it.
        </p>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <div className="panel rack-grid col-span-12 p-4 lg:col-span-7">
          <div className="panel-label mb-2">What the crew knows about your codebase</div>
          <svg
            viewBox="0 0 620 250"
            className="h-[300px] w-full"
            role="img"
            aria-label="Shared memory graph: confirmed knowledge, crew-shared findings, out-of-date notes and proposals waiting for review, all linked to files."
          >
            {EDGES.map(([a, b]) => {
              const from = NODES.find((n) => n.id === a)!;
              const to = NODES.find((n) => n.id === b)!;
              return (
                <line
                  key={`${a}${b}`}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke="oklch(1 0 0 / 18%)"
                  strokeWidth="1"
                  className="animate-edge-dash"
                />
              );
            })}

            {NODES.map((n) => (
              <g key={n.id}>
                <circle cx={n.x} cy={n.y} r={n.r + 6} fill={n.tone} opacity="0.12" />
                <circle cx={n.x} cy={n.y} r={n.r} fill={n.tone} />
                <text
                  x={n.x + n.r + 8}
                  y={n.y + 3}
                  fill="oklch(0.72 0.005 285)"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {n.label}
                </text>
              </g>
            ))}
          </svg>
        </div>

        <div className="panel col-span-12 flex flex-col lg:col-span-5">
          <div className="border-b border-border bg-foreground/5 px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em]">
            Waiting for your call
          </div>
          <ul className="divide-y divide-border">
            {REVIEW.map((item) => (
              <li key={item.path} className="p-4">
                <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em]">
                  <span className={`size-1.5 rounded-full ${item.dot}`} />
                  <span className={item.tone}>{item.agent}</span>
                  <span className="ml-auto text-muted-foreground">{item.path}</span>
                </div>
                <p className="text-sm text-foreground/85">{item.text}</p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    className="border border-muon-blue px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-trust-human transition-colors hover:bg-muon-blue hover:text-primary-foreground"
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className="border border-border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Reject · kept for provenance
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
