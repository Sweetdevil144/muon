import { describe, expect, it, vi } from "vitest";
import { workflowDefinitionSchema } from "@muon/protocol";
import {
  buildPlannerBrief,
  extractJsonObject,
  GRAPH_DISCIPLINE_LINE,
  heuristicWorkflowProposal,
  proposalFromTemplate,
  proposeWorkflowViaLane,
} from "../src/planner.js";
import { renderMemorySlice, withMemorySlice } from "../src/memory-slice.js";

const VALID_PROPOSAL_JSON = JSON.stringify({
  summary: "Fix the rate limiter",
  steps: [
    {
      stepKey: "fix",
      title: "Fix the rate limiter",
      brief: "Find and fix the login rate limiter bug.",
      role: "suggest",
      priority: "high",
    },
  ],
});

describe("proposalFromTemplate", () => {
  it("materializes briefs by filling {{request}} placeholders", () => {
    const definition = workflowDefinitionSchema.parse({
      steps: [
        {
          stepKey: "reproduce",
          title: "Reproduce with a failing test",
          briefTemplate: "Reproduce this bug: {{request}}",
          role: "suggest",
          harnessKey: "implement",
          parallel: {
            group: "bugfix-split",
            independent: true,
            paths: ["tests/auth"],
          },
        },
        {
          stepKey: "fix",
          title: "Fix until checks pass",
          briefTemplate: "Fix: {{request}}",
          role: "suggest",
          loop: { kind: "check_repair", maxIterations: 3 },
          parallel: {
            group: "bugfix-split",
            independent: true,
            paths: ["src/auth"],
          },
        },
      ],
    });

    const proposal = proposalFromTemplate(definition, "login 500s", {
      templateKey: "bugfix",
    });

    expect(proposal.templateKey).toBe("bugfix");
    expect(proposal.steps[0].brief).toBe("Reproduce this bug: login 500s");
    expect(proposal.steps[1].loop?.maxIterations).toBe(3);
    expect(proposal.steps[0].parallel).toEqual({
      group: "bugfix-split",
      independent: true,
      paths: ["tests/auth"],
    });
  });
});

describe("heuristicWorkflowProposal", () => {
  it("wraps the regex splitter into a stored-proposal shape", () => {
    const proposal = heuristicWorkflowProposal(
      "fix the login bug; then add rate limit docs"
    );
    expect(proposal.steps.length).toBe(2);
    expect(proposal.steps[0].stepKey).toBe("task-1");
    expect(proposal.steps[0].priority).toBe("high");
    expect(proposal.steps[1].priority).toBe("low");
  });

  it("appends the graph-discipline line to the raw fallback briefs", () => {
    const proposal = heuristicWorkflowProposal("fix the login bug");
    expect(proposal.steps[0].brief).toContain("fix the login bug");
    expect(proposal.steps[0].brief).toContain(GRAPH_DISCIPLINE_LINE);
    expect(proposal.steps[0].brief).toMatch(/code_query/);
    expect(proposal.steps[0].brief).toMatch(/preflight_edit/);
  });
});

describe("extractJsonObject", () => {
  it("parses plain JSON, fenced JSON, and JSON wrapped in prose", () => {
    expect(extractJsonObject(`{"a":1}`)).toEqual({ a: 1 });
    expect(extractJsonObject("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(
      extractJsonObject(`Sure! Here is the plan:\n{"a":{"b":2}}\nHope it helps.`)
    ).toEqual({ a: { b: 2 } });
    expect(() => extractJsonObject("no json here")).toThrow(/no JSON object/);
  });
});

describe("proposeWorkflowViaLane", () => {
  const context = {
    laneKeys: ["claude-code", "codex"],
    harnessKeys: ["implement", "review"],
    templateKeys: ["bugfix"],
  };

  it("returns a validated proposal from lane output", async () => {
    const runTask = vi.fn(async () => ({
      exitCode: 0,
      output: `Here you go:\n${VALID_PROPOSAL_JSON}`,
    }));

    const proposal = await proposeWorkflowViaLane({
      request: "fix the rate limiter",
      context,
      runTask,
    });

    expect(proposal.summary).toBe("Fix the rate limiter");
    expect(runTask).toHaveBeenCalledTimes(1);
    const brief = runTask.mock.calls[0][0].brief;
    expect(brief).toContain("Available lanes: claude-code, codex");
    expect(brief).toContain("ONLY a JSON object");
  });

  it("retries once with the validation error, then throws", async () => {
    const runTask = vi.fn(async () => ({
      exitCode: 0,
      output: "not json at all",
    }));

    await expect(
      proposeWorkflowViaLane({ request: "fix it", context, runTask })
    ).rejects.toThrow(/valid workflow proposal/);
    expect(runTask).toHaveBeenCalledTimes(2);
    expect(runTask.mock.calls[1][0].brief).toContain(
      "Your previous reply was invalid"
    );
  });

  it("recovers on the retry when the second reply is valid", async () => {
    const runTask = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, output: "garbage" })
      .mockResolvedValueOnce({ exitCode: 0, output: VALID_PROPOSAL_JSON });

    const proposal = await proposeWorkflowViaLane({
      request: "fix it",
      context,
      runTask,
    });
    expect(proposal.steps[0].stepKey).toBe("fix");
  });
});

describe("memory slice", () => {
  it("renders vouched notes, labels stale notes, and prepends them to briefs", () => {
    const notes = [
      { kind: "decision", text: "TTL lives in config", confirmed: true, stale: false },
      { kind: "attempt", text: "env override failed", confirmed: false, stale: false },
      { kind: "constraint", text: "old note", confirmed: true, stale: true },
    ];

    const slice = renderMemorySlice(notes);
    expect(slice).toContain("[decision] TTL lives in config");
    expect(slice).not.toContain("env override failed");
    expect(slice).toContain("[constraint|STALE] old note");

    expect(withMemorySlice("Fix it.", notes)).toContain("Shared memory");
    expect(withMemorySlice("Fix it.", [])).toBe("Fix it.");
  });

  it("buildPlannerBrief embeds the request and catalog keys", () => {
    const brief = buildPlannerBrief("fix login", {
      laneKeys: ["codex"],
      harnessKeys: ["implement"],
      templateKeys: ["bugfix"],
    });
    expect(brief).toContain("Request: fix login");
    expect(brief).toContain("Available harnesses: implement");
    expect(brief).toContain('"parallel"');
    expect(brief).toMatch(/only.*genuinely independent/i);
    expect(brief).toMatch(/2-3/);
    // Rules now demand graph discipline + named DELIVERABLES/CHECKS per step.
    expect(brief).toMatch(/code_query/);
    expect(brief).toMatch(/preflight_edit/);
    expect(brief).toMatch(/DELIVERABLES and CHECKS/);
  });
});
