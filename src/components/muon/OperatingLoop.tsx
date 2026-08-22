const STEPS = [
  {
    number: "01",
    label: "Plan",
    title: "Turn a goal into clear jobs",
    description:
      "MUON records what you want done, breaks it into owned steps, and suggests who should do each part.",
    tone: "bg-muon-blue",
  },
  {
    number: "02",
    label: "Assign",
    title: "Put the right tool on the right job",
    description:
      "Claude Code and Codex build. Cursor and OpenCode explore and review. Every job has limits and a clear owner.",
    tone: "bg-trust-crew",
  },
  {
    number: "03",
    label: "Coordinate",
    title: "Keep everyone on the same page",
    description:
      "Shared memory, handoffs and live updates move with the work, so you are not copy-pasting between chat windows.",
    tone: "bg-muon-yellow",
  },
  {
    number: "04",
    label: "Review",
    title: "Decide with the full picture",
    description:
      "Your team reviews the change, the checks and the trail before anything merges into the main project.",
    tone: "bg-muon-red",
  },
];

export function OperatingLoop() {
  return (
    <section id="how" className="border-t border-border py-20 lg:py-28">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="panel-label mb-3">How it works</p>
          <h2 className="font-sans text-[1.75rem] font-semibold tracking-[-0.02em] lg:text-4xl">
            Plan. Assign. Coordinate. Review.
          </h2>
        </div>
        <p className="max-w-[46ch] text-[0.9375rem] leading-relaxed text-muted-foreground">
          Start with one mission. MUON proposes the plan, runs the crew in safe copies of your
          project, and holds the result for your review.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step) => (
          <div key={step.number} className="panel flex flex-col gap-3 p-5">
            <div className="flex items-center gap-3">
              <span className={`size-6 ${step.tone}`} />
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {step.number} · {step.label}
              </span>
            </div>
            <h3 className="font-sans text-lg font-semibold tracking-[-0.01em]">{step.title}</h3>
            <p className="text-[0.9375rem] leading-relaxed text-muted-foreground">
              {step.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
