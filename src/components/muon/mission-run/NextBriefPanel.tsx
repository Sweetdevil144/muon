import { MEMORY_NODES } from "@/lib/demo-run/script";
import { useDemoRun } from "@/lib/demo-run/store";

import { trustOf } from "./MemoryGraph";

export function NextBriefPanel() {
  const { state } = useDemoRun();

  const lines = MEMORY_NODES.filter(
    (n) => n.briefLine && trustOf(n, state.memory) === "confirmed",
  ).map((n) =>
    state.memory[n.id] === "confirmed" ? `${n.briefLine} (confirmed by you)` : n.briefLine!,
  );

  return (
    <div className="panel p-4">
      <div className="panel-label mb-3">What a LATER mission&apos;s agent receives</div>
      <ul className="space-y-2">
        {lines.map((line) => (
          <li
            key={line}
            className="border-l-2 pl-3 font-mono text-[11px] leading-relaxed text-foreground/85"
            style={{ borderColor: "var(--trust-human)" }}
          >
            {line}
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
        Unconfirmed proposals are not in this pack. Neither is a note from another workspace.
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        Unconfirmed findings stay fenced to the mission that produced them. Confirming is what
        carries a note beyond it.
      </p>
    </div>
  );
}
