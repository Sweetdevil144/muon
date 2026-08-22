import { describe, expect, it, vi } from "vitest";
import type { MuonApiClient, WorkflowRunRecord } from "@muon/client";
import { WorkflowsPane } from "../src/shell/workflows-pane.js";
import { Desk } from "../src/shell/desk.js";
import { emptyBrainSnapshot } from "../src/lib/brain-store.js";

// ── ADR-0087 M3 — the consent surface ───────────────────────────────────────
//
// The bar, from the retirement ledger: the FULL step table (crew member,
// mode, gate, handoff, on-failure per step) renders BEFORE consent, and
// nothing runs until the exact plan is applied — apply FILES tasks and the
// confirmation says so.

const strip = (lines: string[]) =>
  lines.map((line) => line.replaceAll(/\[[0-9;]*m/g, "")).join("\n");

function run(over: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    id: "cmb4wfrun0001abcdefghijkl",
    request: "add retries",
    proposal: {
      summary: "add retries to the fetcher",
      steps: [
        {
          stepKey: "task-1",
          title: "implement the retry wrapper",
          brief: "b",
          role: "suggest",
          laneKey: "codex",
          priority: "medium",
          harnessKey: "implement",
          gate: "merge",
          handoffTo: "task-2",
          onFail: "escalate",
        },
        {
          stepKey: "task-2",
          title: "review the wrapper",
          brief: "b",
          role: "human",
          priority: "medium",
          onFail: "abort",
        },
      ],
    },
    status: "proposed",
    proposedBy: "heuristic",
    createdAt: "x",
    updatedAt: "x",
    ...over,
  } as WorkflowRunRecord;
}

describe("the consent table", () => {
  it("renders EVERY governance coordinate per step, before the verbs", () => {
    const text = strip(
      new WorkflowsPane({
        phase: "list",
        runs: [run()],
        cursor: 0,
        busy: null,
        withheldForeign: 0,
      }).render(240)
    );
    expect(text).toContain("crew codex");
    expect(text).toContain("mode implement");
    expect(text).toContain("gate merge");
    expect(text).toContain("handoff → task-2");
    expect(text).toContain("on-fail escalate");
    expect(text).toContain("crew human");
    expect(text).toContain("on-fail abort");
    // The consent line states what apply DOES — files, never runs.
    expect(text).toContain("a apply — file these tasks exactly as shown");
  });

  it("a non-proposed run offers NO consent verbs — the record states its status", () => {
    const text = strip(
      new WorkflowsPane({
        phase: "list",
        runs: [run({ status: "applied" })],
        cursor: 0,
        busy: null,
        withheldForeign: 0,
      }).render(240)
    );
    expect(text).not.toContain("a apply");
    expect(text).toContain("this run is applied — nothing to consent to");
  });
});

describe("the workspace fence", () => {
  it("withheld foreign runs are COUNTED on screen, never silently dropped", () => {
    const text = strip(
      new WorkflowsPane({
        phase: "list",
        runs: [],
        cursor: 0,
        busy: null,
        withheldForeign: 3,
      }).render(200)
    );
    expect(text).toContain("3 run(s) in other workspaces not shown");
    expect(text).toContain("no workflow runs for this workspace");
  });
});

describe("the desk flow", () => {
  function makeDesk(clientOver: Record<string, unknown> = {}) {
    const snapshot = emptyBrainSnapshot();
    const calls = {
      listWorkflowRuns: vi.fn(async () => [run()]),
      applyWorkflowRun: vi.fn(async () => ({ run: run({ status: "applied" }), tasks: [{}, {}] })),
      updateWorkflowRun: vi.fn(async () => run({ status: "abandoned" })),
      ...clientOver,
    };
    const desk = new Desk({
      client: calls as unknown as MuonApiClient,
      getSnapshot: () => snapshot,
      geometry: () => ({ cols: 80, rows: 12 }),
      terminalRows: () => 30,
      cwd: () => "/repo",
      frozen: [],
      onChange: () => {},
      onQuit: () => {},
    });
    return { desk, calls };
  }
  const PREFIX = String.fromCodePoint(2);

  it("ctrl+b r loads the runs (proposed first); a applies through the real verb with the surface principal", async () => {
    const { desk, calls } = makeDesk({
      listWorkflowRuns: vi.fn(async () => [
        run({ id: "done-1", status: "done" }),
        run(),
        // A FOREIGN workspace's proposal: withheld by the fence — the
        // apply below must reach the local run, never this one.
        run({ id: "foreign-1", workspacePath: "/elsewhere" } as never),
      ]),
    });
    desk.handleKey(PREFIX);
    desk.handleKey("r");
    await vi.waitFor(() => expect(desk.centreKind()).toBe("workflows"));
    await vi.waitFor(() =>
      expect(calls.listWorkflowRuns).toHaveBeenCalled()
    );
    // Proposed sorts FIRST — the consent queue leads.
    desk.handleKey("a");
    await vi.waitFor(() => expect(calls.applyWorkflowRun).toHaveBeenCalled());
    expect(calls.applyWorkflowRun).toHaveBeenCalledWith(
      "cmb4wfrun0001abcdefghijkl",
      "human:tui"
    );
  });

  it("x dismisses via the abandoned status; a non-proposed selection refuses both verbs", async () => {
    const { desk, calls } = makeDesk();
    desk.handleKey(PREFIX);
    desk.handleKey("r");
    await vi.waitFor(() => expect(calls.listWorkflowRuns).toHaveBeenCalled());
    desk.handleKey("x");
    await vi.waitFor(() => expect(calls.updateWorkflowRun).toHaveBeenCalled());
    expect(calls.updateWorkflowRun).toHaveBeenCalledWith({
      runId: "cmb4wfrun0001abcdefghijkl",
      status: "abandoned",
    });

    const applied = makeDesk({
      listWorkflowRuns: vi.fn(async () => [run({ status: "applied" })]),
    });
    applied.desk.handleKey(PREFIX);
    applied.desk.handleKey("r");
    await vi.waitFor(() =>
      expect(applied.calls.listWorkflowRuns).toHaveBeenCalled()
    );
    applied.desk.handleKey("a");
    applied.desk.handleKey("x");
    expect(applied.calls.applyWorkflowRun).not.toHaveBeenCalled();
    expect(applied.calls.updateWorkflowRun).not.toHaveBeenCalled();
  });
});
