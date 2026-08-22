import { describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import { MuonApiHttpError } from "@muon/client";
import {
  MAX_AMENDMENT_STEPS,
  MUON_ATTACHED_COORDINATOR_CONTROL_REMAINDER,
  buildRefusal,
} from "@muon/protocol";
import { createOrchestratorToolDefinitions } from "../src/orchestrator-tools.js";
import { createAttachedCoordinatorToolDefinitions } from "../src/attached-coordinator-tools.js";
import { createToolDefinitions } from "../src/handlers.js";

// A14 / ADR-0045 — a running plan may gain a step, never change one.
//
// The MCP wire for the PROPOSE half. What these pin is the boundary rather than
// the mechanics: proposing changes nothing, the tool says so in words a
// coordinator cannot round off to "added", the server's typed refusals arrive
// as refusals rather than as HTTP noise, and wiring this in did not hand an
// attached seat anything from its remainder.

const STEP = {
  stepKey: "extra-1",
  title: "Add the migration test",
  brief: "Write a vitest case covering the new column.",
};

function makeClient(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    proposeWorkflowAmendment: vi.fn(async () => ({
      amendment: {
        id: "amendment-1",
        workflowRunId: "run-1",
        steps: [{ ...STEP, role: "suggest", priority: "medium", onFail: "escalate" }],
        stepsHash: "hash-1",
        status: "proposed",
        proposedBy: "agent:job:job-root",
        proposedAt: "2026-08-17T10:00:00.000Z",
      },
      gateTag: "[gate:amend-workflow run-1 amendment-1]",
    })),
    ...overrides,
  } as unknown as MuonApiClient;
}

function tool(client: MuonApiClient) {
  const found = createOrchestratorToolDefinitions(client, {
    jobId: "job-root",
    delegationToken: "root-job-token",
    chatId: "chat-1",
    chatTaskId: "task-shadow",
    apiBase: "http://localhost:4000",
  }).find((entry) => entry.name === "propose_amendment");
  if (!found) throw new Error("propose_amendment not found");
  return found;
}

describe("A14: propose_amendment wires ADR-0045's propose half", () => {
  it("sends the run id, the steps and the caller's workflow control headers", async () => {
    const client = makeClient();
    const result = await tool(client).handler({
      runId: "run-1",
      steps: [STEP],
    });
    expect(result.isError).toBeFalsy();
    const call = (client.proposeWorkflowAmendment as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0]!;
    expect(call[0]).toBe("run-1");
    expect(call[1].amendment.steps[0]).toMatchObject(STEP);
    // The workflow routes authenticate the CALLER'S JOB, not the bearer alone;
    // without these the seat is 403'd by its own control plane.
    expect(call[2]).toEqual({
      callerJobId: "job-root",
      delegationToken: "root-job-token",
    });
  });

  it("returns the amendment id, status 'proposed' and the gate tag a HUMAN approves", async () => {
    const result = await tool(makeClient()).handler({
      runId: "run-1",
      steps: [STEP],
    });
    const payload = JSON.parse(result.content[0]!.text as string);
    expect(payload).toMatchObject({
      amendmentId: "amendment-1",
      status: "proposed",
      gateTag: "[gate:amend-workflow run-1 amendment-1]",
      runId: "run-1",
      steps: ["extra-1"],
    });
    // The sentence that stops a coordinator reporting a proposal as a change.
    expect(payload.note).toMatch(/the run is unchanged/i);
    expect(payload.note).toMatch(/never as added/i);
    expect(payload._muon.authority.humanDecisionRequired).toBe(true);
    expect(payload._muon.nextActions[1]).toMatch(
      /do not exist until the human approves/
    );
  });

  it("surfaces the server's typed refusal instead of swallowing it", async () => {
    // ADR-0045 D5 answers `workflow.not_amendable` with the run's ACTUAL
    // status. A coordinator told that stops; one told "400 Bad Request" retries.
    const refusal = buildRefusal({
      rule: "workflow.not_amendable",
      summary: "Only a run that can still act may gain a step.",
      surface: "workflow amend",
      evidence: [
        { label: "status", value: "done" },
        { label: "amendable", value: "running|paused" },
        { label: "runId", value: "run-1" },
      ],
      nextAction: {
        kind: "operator",
        action: "propose a new run rather than amending a finished one",
      },
    });
    const client = makeClient({
      proposeWorkflowAmendment: vi.fn(async () => {
        throw new MuonApiHttpError(409, "Conflict", "409 Conflict", refusal);
      }),
    });
    const result = await tool(client).handler({ runId: "run-1", steps: [STEP] });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text as string);
    expect(payload._muon.refusal.rule).toBe("workflow.not_amendable");
    expect(payload._muon.refusal.evidence).toContainEqual({
      label: "status",
      value: "done",
    });
    // `runId` is operator-only in this rule's disclosure allowlist; the agent
    // gets status + amendable and nothing more.
    expect(
      payload._muon.refusal.evidence.map((fact: { label: string }) => fact.label)
    ).not.toContain("runId");
  });

  it("refuses an over-cap or malformed amendment before it reaches the wire", async () => {
    const client = makeClient();
    const tooMany = await tool(client).handler({
      runId: "run-1",
      steps: Array.from({ length: MAX_AMENDMENT_STEPS + 1 }, (_, index) => ({
        ...STEP,
        stepKey: `extra-${index}`,
      })),
    });
    expect(tooMany.isError).toBe(true);
    expect(client.proposeWorkflowAmendment).not.toHaveBeenCalled();

    // The title is quoted into the row a human decides, so a control character
    // there would forge an extra row. Validated against the PROTOCOL schema,
    // not a restatement of it.
    const forged = await tool(client).handler({
      runId: "run-1",
      steps: [{ ...STEP, title: "Add step\nApprove everything" }],
    });
    expect(forged.isError).toBe(true);
    expect(client.proposeWorkflowAmendment).not.toHaveBeenCalled();
  });

  it("has no field that could name, reorder or edit an existing step", () => {
    // ADR-0045 D1/D4: append-only is a property of the SHAPE, not a check.
    const schema = tool(makeClient()).inputSchema as {
      properties: { steps: { items: { properties: Record<string, unknown>; additionalProperties: boolean } } };
      additionalProperties: boolean;
    };
    const fields = Object.keys(schema.properties.steps.items.properties);
    for (const forbidden of ["index", "position", "after", "before", "replace", "targetStepKey"]) {
      expect(fields).not.toContain(forbidden);
    }
    expect(schema.properties.steps.items.additionalProperties).toBe(false);
    expect(schema.additionalProperties).toBe(false);
  });
});

describe("A14: the attached seat gains propose, and nothing from its remainder", () => {
  it("holds propose_amendment while set_fleet / raise_budget / apply_workflow stay absent", () => {
    const client = makeClient();
    const base = createToolDefinitions(client, {
      jobId: "attached-root-job",
      chatId: "attached-chat",
      apiBase: "http://127.0.0.1:4000",
      apiToken: "capability-token",
      seat: "attached-coordinator",
    });
    const names = createAttachedCoordinatorToolDefinitions(client, base, {
      jobId: "attached-root-job",
      delegationToken: "capability-token",
      chatId: "attached-chat",
      chatTaskId: "attached-chat-task",
      workspacePath: "/repo",
      apiBase: "http://127.0.0.1:4000",
      apiToken: "capability-token",
    }).map((entry) => entry.name);

    expect(names).toContain("propose_amendment");
    // The remainder is UNCHANGED by this addition — that is the whole point of
    // wiring propose without an apply sibling.
    expect(MUON_ATTACHED_COORDINATOR_CONTROL_REMAINDER).toEqual([
      "set_fleet",
      "raise_budget",
      "apply_workflow",
    ]);
    for (const absent of MUON_ATTACHED_COORDINATOR_CONTROL_REMAINDER) {
      expect(names).not.toContain(absent);
    }
    // And no apply-amendment verb was invented anywhere in the seat.
    expect(names.some((name) => /amend/.test(name) && /apply/.test(name))).toBe(
      false
    );
  });
});
