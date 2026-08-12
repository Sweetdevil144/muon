export type PlanLaneSuggestion = {
  laneId: string;
  laneKey: string;
  laneName: string;
  score: number;
  reason: string;
};

export type PlannedTask = {
  title: string;
  description: string;
  priority: "low" | "medium" | "high";
};

const PRIORITY_HINTS: Record<string, PlannedTask["priority"]> = {
  urgent: "high",
  critical: "high",
  asap: "high",
  fix: "high",
  bug: "high",
  broken: "high",
  cleanup: "low",
  docs: "low",
  document: "low",
  polish: "low",
};

/**
 * Thin superagent planning heuristic (WIKI §8.2: the superagent breaks work
 * into tasks and suggests lanes, it never assigns on its own). Splits a
 * request into task candidates on newline bullets, semicolons, or " then ".
 */
export function splitRequestIntoTasks(request: string): PlannedTask[] {
  const parts = request
    .split(/\n+|;|(?:\.\s+(?:then|next|after that)\s+)|(?:\s+then\s+)/i)
    .map((part) => part.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((part) => part.length >= 8);

  const source = parts.length > 0 ? parts : [request.trim()];

  return source.map((part) => {
    const lower = part.toLowerCase();
    let priority: PlannedTask["priority"] = "medium";
    for (const [hint, value] of Object.entries(PRIORITY_HINTS)) {
      if (lower.includes(hint)) {
        priority = value;
        break;
      }
    }
    const title = part.length > 72 ? `${part.slice(0, 69)}...` : part;
    return {
      title,
      description: part.length >= 10 ? part : `${part} (from muon plan)`,
      priority,
    };
  });
}

export function renderPlan(
  tasks: { planned: PlannedTask; suggestions: PlanLaneSuggestion[] }[]
): string {
  const lines: string[] = ["proposed plan (nothing is created yet):", ""];
  tasks.forEach(({ planned, suggestions }, index) => {
    const top = suggestions[0];
    lines.push(`${index + 1}. [${planned.priority}] ${planned.title}`);
    if (top) {
      lines.push(
        `   suggested lane: ${top.laneName} (${top.laneKey}), ${top.reason}`
      );
    }
  });
  lines.push("");
  lines.push("apply with: muon plan \"<same request>\" --apply");
  lines.push("(each task is created and assigned to its suggested lane only on --apply)");
  return `${lines.join("\n")}\n`;
}
