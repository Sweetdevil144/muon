import { useDemoRun } from "@/lib/demo-run/store";

export function EventLog({ limit }: { limit?: number }) {
  const { frame, state } = useDemoRun();
  const beats = limit ? frame.beats.slice(-limit) : frame.beats;
  const latest = frame.beats[frame.beats.length - 1];

  return (
    <div>
      <ol className="divide-y divide-border">
        {beats.map((b) => (
          <li key={b.n} className="px-3 py-2">
            <div className="mb-1 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <span>{(b.t / 1000).toFixed(1)}s</span>
              <span className="text-foreground/80">{b.lane}</span>
              {b.tool ? <span>{b.tool}</span> : null}
            </div>
            <p className="text-[13px] leading-relaxed text-foreground/85">{b.text}</p>
            {b.sub ? (
              <p
                className="mt-1 text-[11px] leading-relaxed"
                style={{
                  color:
                    b.n === 15 || b.n === 18 ? "var(--trust-stale)" : "var(--muted-foreground)",
                }}
              >
                {b.sub}
              </p>
            ) : null}
          </li>
        ))}
        {state.gateLog.map((d, i) => (
          <li key={`gate-${i}`} className="px-3 py-2">
            <div className="mb-1 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <span className="text-foreground/80">you</span>
              <span>merge gate MRG-4417</span>
            </div>
            <p
              className="text-[13px] leading-relaxed"
              style={{
                color: d === "approved" ? "var(--trust-human)" : "var(--trust-unconfirmed)",
              }}
            >
              {d === "approved"
                ? "Approved by you — the lane's worktree commit landed on the primary checkout."
                : "Rejected by you — nothing merged; the lane keeps its worktree and its commit."}
            </p>
          </li>
        ))}
      </ol>
      <p aria-live="polite" className="sr-only">
        {latest ? `${latest.lane}: ${latest.text}` : ""}
      </p>
    </div>
  );
}
