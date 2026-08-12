import {
  workflowProposalSchema,
  type WorkflowProposal,
} from "@muon/protocol";

// Server-side twin of the heuristic splitter in packages/core/src/plan-builder.ts
// (the frontend cannot import @muon/core, it pulls in child_process via the
// adapters). Keep the two in sync until a shared planner package exists.

const PRIORITY_HINTS: Record<string, "low" | "medium" | "high"> = {
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

export function buildHeuristicProposal(request: string): WorkflowProposal {
  const parts = request
    .split(/\n+|;|(?:\.\s+(?:then|next|after that)\s+)|(?:\s+then\s+)/i)
    .map((part) => part.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((part) => part.length >= 8);

  const source = parts.length > 0 ? parts : [request.trim()];

  return workflowProposalSchema.parse({
    summary: request.slice(0, 100),
    steps: source.map((part, index) => {
      const lower = part.toLowerCase();
      let priority: "low" | "medium" | "high" = "medium";
      for (const [hint, value] of Object.entries(PRIORITY_HINTS)) {
        if (lower.includes(hint)) {
          priority = value;
          break;
        }
      }
      return {
        stepKey: `task-${index + 1}`,
        title: part.length > 72 ? `${part.slice(0, 69)}...` : part,
        brief: part.length >= 10 ? part : `${part} (from muon plan)`,
        role: "suggest",
        priority,
      };
    }),
  });
}
