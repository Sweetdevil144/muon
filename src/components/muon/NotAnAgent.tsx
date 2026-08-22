const IS = [
  "A local command center for the AI coding tools you already pay for",
  "One mission, split into owned jobs with limits and checkpoints",
  "Shared memory so agents stop re-learning your codebase",
  "Approvals and review before anything merges",
];

const IS_NOT = [
  "Another coding model — Claude Code, Codex, Cursor and OpenCode still write the code",
  "A hosted service that needs your source in someone else's cloud",
  "A replacement for your AI subscriptions — you bring your own accounts",
  "Set-and-forget autonomy — people still decide what ships",
];

export function NotAnAgent() {
  return (
    <section className="border-t border-border py-20 lg:py-28">
      <div className="mb-8">
        <p className="panel-label mb-3">The short version</p>
        <h2 className="max-w-[26ch] font-sans text-[1.75rem] font-semibold tracking-[-0.02em] lg:text-4xl">
          MUON is not another coding agent. It runs the team around them.
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="panel p-6">
          <div className="mb-4 flex items-center gap-3">
            <span className="size-2.5 bg-trust-crew" />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              What MUON is
            </span>
          </div>
          <ul className="space-y-3">
            {IS.map((item) => (
              <li key={item} className="flex gap-3 text-[0.9375rem] leading-relaxed">
                <span className="mt-2 size-1.5 shrink-0 bg-trust-crew" />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="panel p-6">
          <div className="mb-4 flex items-center gap-3">
            <span className="size-2.5 bg-muted-foreground" />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              What MUON is not
            </span>
          </div>
          <ul className="space-y-3">
            {IS_NOT.map((item) => (
              <li
                key={item}
                className="flex gap-3 text-[0.9375rem] leading-relaxed text-muted-foreground"
              >
                <span className="mt-2 size-1.5 shrink-0 bg-muted-foreground" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
