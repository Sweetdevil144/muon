import { useDemoRun } from "@/lib/demo-run/store";

export function LaneColumn({ compact = false }: { compact?: boolean }) {
  const { frame, reduced } = useDemoRun();

  return (
    <ul className="divide-y divide-border">
      {frame.lanes.map((lane) => (
        <li key={lane.lane}>
          <div
            className="flex w-full items-start gap-3 px-3 py-2 text-left"
            style={{ opacity: lane.status === "Waiting for dispatch" ? 0.45 : 1 }}
          >
            <span
              className="mt-1 block h-8 w-[3px] shrink-0"
              style={{ backgroundColor: lane.tone }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs font-bold">{lane.lane}</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  {lane.role === "qa" ? "QA" : lane.role}
                </span>
              </div>
              {!compact && (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {lane.subtitle}
                </p>
              )}
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                {lane.status}
              </p>
            </div>
            {lane.active && !reduced ? (
              <span
                className="animate-gate-pulse mt-1.5 size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: lane.tone }}
              />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
