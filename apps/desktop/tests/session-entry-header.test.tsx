// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  buildSessionHeaderFacts,
  newestDecidedGate,
} from "../src/renderer/lib/session-entry-header.js";
import { SessionWorkspace } from "../src/renderer/session-workspace.js";
import type { ApprovalRequest, DispatchBudget } from "@muon/client";

vi.mock("../src/renderer/lib/xterm-view.js", () => ({
  createXtermView: () => ({
    write: vi.fn(),
    onInput: () => ({ dispose: vi.fn() }),
    onResize: () => ({ dispose: vi.fn() }),
    markExited: vi.fn(),
    dispose: vi.fn(),
  }),
}));

afterEach(cleanup);

/**
 * ROADMAP H6 — an audit-true session entry header.
 *
 * The two rules under test, and they are the whole feature: every fact is read
 * off a LEDGER RECORD (the same records `muon dispatch status` prints from), and
 * a fact that cannot be sourced yields NO LINE — never a placeholder, because a
 * placeholder is a claim ("no gate has been decided") that the header is not in
 * a position to make.
 */

const decided = (over: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ({
    id: "approval-1",
    taskId: "task-1",
    requestedBy: "codex",
    kind: "merge",
    reason: "ship",
    status: "approved",
    decidedAt: "2026-08-17T09:04:11.000Z",
    createdAt: "2026-08-17T09:00:00.000Z",
    ...over,
  }) as ApprovalRequest;

const budget = (over: Partial<DispatchBudget> = {}): DispatchBudget => ({
  jobId: "job-1",
  rootWallMs: 1_800_000,
  maxDescendantWallMs: 1_800_000,
  poolMs: 1_800_000,
  reservedMs: 0,
  consumedMs: 900_000,
  remainingMs: 900_000,
  deadlineAt: null,
  childrenIssued: 1,
  maxChildren: 3,
  descendantsIssued: 1,
  maxDescendants: 8,
  depth: 0,
  maxDepth: 3,
  children: [],
  ...over,
});

describe("H6 — buildSessionHeaderFacts composes from the ledger", () => {
  it("names the last decided gate: kind, status and when", () => {
    const facts = buildSessionHeaderFacts({
      taskId: "task-1",
      decidedApprovals: [decided()],
    });
    const gate = facts.find((fact) => fact.id === "gate")!;
    expect(gate.value).toMatch(/merge/);
    expect(gate.value).toMatch(/approved/);
    expect(gate.value).toMatch(/2026-08-17 09:04/);
    expect(gate.tone).toBe("ready");
  });

  it("a REJECTED gate is not the same news as an approved one", () => {
    const facts = buildSessionHeaderFacts({
      taskId: "task-1",
      decidedApprovals: [decided({ status: "rejected" })],
    });
    expect(facts.find((fact) => fact.id === "gate")!.tone).toBe("danger");
  });

  it("quotes the newest DECISION, not the newest creation", () => {
    // The window arrives decision-ordered, but a header must not depend on a
    // producer's ordering to be correct about which record it is quoting.
    const older = decided({
      id: "old",
      createdAt: "2026-08-17T09:30:00.000Z",
      decidedAt: "2026-08-17T09:31:00.000Z",
      kind: "command",
    });
    const newer = decided({
      id: "new",
      createdAt: "2026-08-17T08:00:00.000Z",
      decidedAt: "2026-08-17T10:00:00.000Z",
      kind: "merge",
    });
    expect(
      newestDecidedGate({ taskId: "task-1", decidedApprovals: [older, newer] })
        ?.id
    ).toBe("new");
  });

  it("reads only THIS task's gates", () => {
    expect(
      newestDecidedGate({
        taskId: "task-1",
        decidedApprovals: [decided({ taskId: "task-other" })],
      })
    ).toBeNull();
  });

  it("shows budget remaining from the dispatch budget record", () => {
    const facts = buildSessionHeaderFacts({ taskId: "task-1", budget: budget() });
    const line = facts.find((fact) => fact.id === "budget")!;
    // Same projection (and therefore the same arithmetic) every budget surface
    // uses: 900_000 ms remaining of a 1_800_000 ms pool.
    expect(line.value).toMatch(/15m/);
    expect(line.value).toMatch(/30m/);
    expect(line.tone).toBe("neutral");
  });

  it("an exhausted pool is the one budget state that needs you", () => {
    const facts = buildSessionHeaderFacts({
      taskId: "task-1",
      budget: budget({ remainingMs: 0, consumedMs: 1_800_000 }),
    });
    expect(facts.find((fact) => fact.id === "budget")!.tone).toBe("danger");
  });

  it("labels a worktree as a worktree, and a checkout as a workspace", () => {
    const worktree = buildSessionHeaderFacts({
      taskId: "task-1",
      executionPath: "/repo/.muon/worktrees/task-1",
      workspacePath: "/repo",
    }).find((fact) => fact.id === "tree")!;
    expect(worktree.label).toMatch(/worktree/i);
    expect(worktree.value).toBe("/repo/.muon/worktrees/task-1");

    const workspace = buildSessionHeaderFacts({
      taskId: "task-1",
      workspacePath: "/repo",
    }).find((fact) => fact.id === "tree")!;
    expect(workspace.label).toMatch(/workspace/i);
    expect(workspace.value).toBe("/repo");
  });
});

describe("H6 — an absent fact is an absent line, never a fake one", () => {
  it("omits the gate line entirely when no gate was decided", () => {
    const facts = buildSessionHeaderFacts({
      taskId: "task-1",
      decidedApprovals: [],
      budget: budget(),
    });
    expect(facts.map((fact) => fact.id)).toEqual(["budget"]);
    // No "Last gate: —", and above all no "no gates decided": the bounded
    // window cannot tell "never decided" from "not in this window".
    expect(facts.some((fact) => /—|none|no gate/i.test(fact.value))).toBe(false);
  });

  it("omits the budget line when the pool could not be read", () => {
    const facts = buildSessionHeaderFacts({
      taskId: "task-1",
      decidedApprovals: [decided()],
      budget: null,
    });
    expect(facts.map((fact) => fact.id)).toEqual(["gate"]);
  });

  it("returns an EMPTY list when nothing at all can be sourced", () => {
    expect(buildSessionHeaderFacts({ taskId: null })).toEqual([]);
    expect(buildSessionHeaderFacts({})).toEqual([]);
  });
});

const AGENT = {
  id: "agent-1",
  vendor: "codex",
  name: "codex-1",
  ordinal: 1,
  status: "working",
  currentTaskId: "task-1",
  currentJobId: "job-1",
} as const;

const JOB = {
  id: "job-1",
  kind: "session",
  vendor: "codex",
  taskId: "task-1",
  brief: "cap the retries",
  status: "done",
  dispatchedBy: "orchestrator",
  interruptRequested: false,
  steerMessages: [],
  capabilityMode: "delegate",
  delegationDepth: 1,
  maxWallMs: 600_000,
  workspacePath: "/repo",
  executionPath: "/repo/.muon/worktrees/task-1",
  createdAt: "2026-08-17T08:00:00.000Z",
} as const;

function renderSession(overrides: Record<string, unknown> = {}, muon = {}) {
  Object.assign(window, {
    muon: {
      streams: vi.fn().mockResolvedValue([]),
      jobResumeProbe: vi.fn().mockResolvedValue({ status: "unavailable", reason: "n/a" }),
      getDispatchBudget: vi.fn().mockResolvedValue(budget()),
      ...muon,
    },
  });
  render(
    React.createElement(SessionWorkspace, {
      agent: AGENT,
      job: JOB,
      taskTitle: "Cap the retries",
      events: [],
      readiness: [],
      decidedApprovals: [decided()],
      onClose: vi.fn(),
      ...overrides,
    } as unknown as Parameters<typeof SessionWorkspace>[0])
  );
}

describe("H6 — the session header renders the ledger facts", () => {
  it("shows the decided gate, the budget and the worktree", async () => {
    renderSession();
    const strip = await screen.findByLabelText("Session ledger facts");
    expect(strip.textContent).toMatch(/merge approved/);
    expect(strip.textContent).toMatch(/2026-08-17 09:04/);
    expect(strip.textContent).toMatch(/15m left of 30m/);
    expect(strip.textContent).toMatch(/Worktree/i);
    expect(strip.textContent).toContain("/repo/.muon/worktrees/task-1");
    // The status it already showed is untouched.
    expect(document.querySelector(".session-status")).toBeTruthy();
  });

  it("omits the budget rather than inventing one when the read is refused", async () => {
    renderSession(
      {},
      {
        getDispatchBudget: vi.fn().mockRejectedValue(
          new Error("The selected chat changed while budget was loading.")
        ),
      }
    );
    const strip = await screen.findByLabelText("Session ledger facts");
    expect(strip.textContent).toMatch(/merge approved/);
    // A refused read must never render as an exhausted or a zero pool.
    expect(strip.textContent).not.toMatch(/left of|exhausted|0s/);
  });

  it("renders NO strip at all when the ledger has nothing to say", () => {
    renderSession(
      {
        job: { ...JOB, workspacePath: null, executionPath: null },
        decidedApprovals: [],
      },
      { getDispatchBudget: vi.fn().mockRejectedValue(new Error("no")) }
    );
    expect(screen.queryByLabelText("Session ledger facts")).toBeNull();
  });

  it("survives a preload with no budget leg at all", async () => {
    renderSession({}, { getDispatchBudget: undefined });
    const strip = await screen.findByLabelText("Session ledger facts");
    expect(strip.textContent).toMatch(/merge approved/);
  });
});
