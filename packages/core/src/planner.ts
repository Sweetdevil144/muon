import {
  workflowProposalSchema,
  type WorkflowDefinition,
  type WorkflowProposal,
} from "@muon/protocol";
import { splitRequestIntoTasks } from "./plan-builder.js";

/**
 * Super-orchestrator planning (VISION §6.1), hybrid by construction:
 * - `proposalFromTemplate` materializes a stored template (deterministic).
 * - `heuristicWorkflowProposal` wraps the regex splitter (offline fallback).
 * - `proposeWorkflowViaLane` runs the planning brief through one of the
 *   user's own lanes, the planner is a lane, not a MUON-owned model, so
 *   BYO auth and official-vendor-surfaces rules stay intact.
 * Every path returns a proposal that is INERT until a human applies it.
 */

export function proposalFromTemplate(
  definition: WorkflowDefinition,
  request: string,
  options?: { templateKey?: string; summary?: string }
): WorkflowProposal {
  return workflowProposalSchema.parse({
    summary:
      options?.summary ??
      `${options?.templateKey ?? "workflow"}: ${request.slice(0, 80)}`,
    templateKey: options?.templateKey,
    steps: definition.steps.map((step) => ({
      stepKey: step.stepKey,
      title: step.title,
      brief: step.briefTemplate.replaceAll("{{request}}", request),
      role: step.role,
      harnessKey: step.harnessKey,
      loop: step.loop,
      gate: step.gate,
      handoffTo: step.handoffTo,
      onFail: step.onFail,
      parallel: step.parallel,
      priority: "medium",
    })),
  });
}

/**
 * A single-line restatement of the code-graph discipline, appended to the raw
 * heuristic-fallback briefs (bare request fragments from splitRequestIntoTasks)
 * so even the offline planner path carries the graph-first + preflight
 * expectation. The lane-planner path gets the same discipline through
 * buildPlannerBrief's Rules.
 */
export const GRAPH_DISCIPLINE_LINE =
  "Graph discipline: orient with code_query before searching source; run atomic preflight_edit with the exact symbol + file path before editing; name your DELIVERABLES and CHECKS.";

function withGraphDisciplineLine(brief: string): string {
  return `${brief}\n\n${GRAPH_DISCIPLINE_LINE}`;
}

export function heuristicWorkflowProposal(request: string): WorkflowProposal {
  const tasks = splitRequestIntoTasks(request);
  return workflowProposalSchema.parse({
    summary: request.slice(0, 100),
    steps: tasks.map((task, index) => ({
      stepKey: `task-${index + 1}`,
      title: task.title,
      brief: withGraphDisciplineLine(task.description),
      role: "suggest",
      priority: task.priority,
    })),
  });
}

/**
 * Extracts the first JSON object from lane output. Models routinely wrap
 * JSON in prose or ``` fences; the zod parse afterwards is the real gate.
 */
export function extractJsonObject(output: string): unknown {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : output;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("no JSON object found in the planner output");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export type PlannerContext = {
  laneKeys: string[];
  harnessKeys: string[];
  templateKeys: string[];
};

export function buildPlannerBrief(
  request: string,
  context: PlannerContext
): string {
  return [
    "You are the MUON super-orchestrator planner. Break the request below into a workflow proposal for a crew of coding agents.",
    "",
    "Reply with ONLY a JSON object (no prose, no markdown fences) of this shape:",
    `{"summary": "<one line>", "steps": [{"stepKey": "<kebab-id>", "title": "<short>", "brief": "<full instructions for the agent>", "role": "suggest" | "human" | <laneKey>, "harnessKey"?: <harnessKey>, "loop"?: {"kind": "check_repair", "maxIterations": 3}, "gate"?: "gate" | "merge", "handoffTo"?: <stepKey>, "parallel"?: {"group": "<group-id>", "independent": true, "paths": ["<relative owned path>"]}, "priority": "low" | "medium" | "high"}]}`,
    "",
    `Available lanes: ${context.laneKeys.join(", ") || "none"}.`,
    `Available harnesses: ${context.harnessKeys.join(", ") || "none"}.`,
    `Available templates (prefer their shape when one fits): ${context.templateKeys.join(", ") || "none"}.`,
    "",
    "Rules: 2-6 steps; use role \"suggest\" unless a specific lane is clearly better; put a loop only on implementation/repair steps; end risky work with a gate; the final shippable step gets gate \"merge\"; never invent lane or harness keys. Use parallel only for genuinely independent work: exactly 2-3 contiguous non-human steps share one group id, each declares disjoint relative path ownership, and parallel steps have no individual gate or handoff. Every implementation or repair step brief must instruct the agent to orient with code_query and to run atomic preflight_edit with each exact symbol + file path before edits, and must name its DELIVERABLES and CHECKS; pick a specific lane role when the step shape clearly matches one (review steps get a different lane than the implementing step).",
    "",
    `Request: ${request}`,
  ].join("\n");
}

export type PlannerRunTask = (args: {
  brief: string;
}) => Promise<{ exitCode: number; output: string }>;

export async function proposeWorkflowViaLane(args: {
  request: string;
  context: PlannerContext;
  runTask: PlannerRunTask;
}): Promise<WorkflowProposal> {
  const brief = buildPlannerBrief(args.request, args.context);
  let lastError = "";

  // One retry with the validation error appended (research brief spike 1).
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt =
      attempt === 1
        ? brief
        : `${brief}\n\nYour previous reply was invalid: ${lastError}\nReply with ONLY the JSON object.`;
    const result = await args.runTask({ brief: prompt });
    try {
      return workflowProposalSchema.parse(extractJsonObject(result.output));
    } catch (error) {
      lastError = (error instanceof Error ? error.message : String(error)).slice(
        0,
        300
      );
    }
  }

  throw new Error(
    `Planner lane did not produce a valid workflow proposal (${lastError}). Falling back to \`muon plan\` heuristics is safe.`
  );
}
