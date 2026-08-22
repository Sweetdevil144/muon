// @vitest-environment jsdom

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopState, WorkspaceReview } from "../src/shared/ipc.js";
import { App } from "../src/renderer/app.js";

/**
 * REACHABILITY, at the App level, for H2 / H3 / H15.
 *
 * A component test proves a section renders when it is handed the right props.
 * It proves nothing about whether the App ever hands them over — and a surface
 * that is correct but unreachable is not shipped. So this file mounts the real
 * App against one desktop state and asserts the three new things are actually
 * on screen, from the props the App itself computed:
 *
 *   H2  — a degraded wrap packet DISABLES "Land this work" and names why.
 *   H3  — the pending merge gate is decidable from the Changes dock.
 *   H15 — an open question is counted in "needs you" and named in the rail.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WORKTREE_PATH = "/work/MUON-LABS/.muon/worktrees/task-1";

const WORKSPACE_REVIEW: WorkspaceReview = {
  status: "available",
  workspacePath: WORKTREE_PATH,
  branch: "detached@abc1234",
  stagedFiles: [],
  unstagedFiles: ["src/pay/charge.ts"],
  files: ["src/pay/charge.ts"],
  stat: "1 file changed, 12 insertions(+), 2 deletions(-)",
  fileStats: [
    { path: "src/pay/charge.ts", additions: 12, deletions: 2, binary: false },
  ],
  diffText: "diff --git a/src/pay/charge.ts b/src/pay/charge.ts",
  truncated: false,
  totalBytes: 1200,
  maxBytes: 200_000,
  tree: { kind: "worktree", path: WORKTREE_PATH, taskId: "task-1" },
};

function desktopState(): DesktopState {
  return {
    online: true,
    lastError: null,
    runnerLive: true,
    fullAuto: false,
    settings: { apiBase: "http://localhost:4000", apiTokenSet: false },
    fleet: { counts: { codex: 1 }, agents: [] },
    chats: [
      {
        id: "chat-1",
        title: "Cap the retries",
        workspacePath: "/work/MUON-LABS",
        status: "active",
        taskId: "task-1",
        createdAt: "2026-08-17T08:00:00.000Z",
        updatedAt: "2026-08-17T08:00:00.000Z",
      },
    ],
    approvals: [
      {
        id: "approval-open-dock",
        taskId: "task-1",
        jobId: "job-root",
        requestedBy: "codex",
        kind: "command",
        reason: "unrelated pending gate (opens the Review dock)",
        status: "pending",
        createdAt: "2026-08-17T08:02:00.000Z",
      },
      {
        id: "approval-merge",
        taskId: "task-1",
        jobId: "job-root",
        requestedBy: "codex",
        kind: "merge",
        reason: "ship requested from MUON desktop: 1 file changed",
        status: "pending",
        createdAt: "2026-08-17T08:03:00.000Z",
      },
    ],
    // H15 — one agent is blocked on a question for this mission's task.
    questions: [
      {
        id: "q-1",
        taskId: "task-1",
        subject: "Which retry ceiling should charge() use?",
        body: "30s or 60s — the spec says both.",
        askedByVendor: "codex",
        askedAt: "2026-08-17T08:04:00.000Z",
        status: "open",
      },
    ],
    questionsTruncated: false,
    questionsUnavailable: false,
    tasks: [
      {
        id: "task-1",
        title: "Cap the retries",
        description: "",
        status: "in_progress",
        priority: "normal",
      },
    ],
    dispatchJobs: [
      {
        id: "job-root",
        kind: "session",
        vendor: "codex",
        taskId: "task-1",
        chatId: "chat-1",
        agentId: "agent-1",
        brief: "Cap the retries in the task worktree.",
        workspacePath: "/work/MUON-LABS",
        executionPath: WORKTREE_PATH,
        status: "done",
        dispatchedBy: "orchestrator",
        interruptRequested: false,
        steerMessages: [],
        capabilityMode: "orchestrator",
        createdAt: "2026-08-17T08:01:00.000Z",
      },
    ],
    auditEvents: [],
    readiness: [],
  } as unknown as DesktopState;
}

function mockMuon(state: DesktopState) {
  const handlers = new Map<string, (payload: never) => void>();
  const resolveApproval = vi.fn().mockResolvedValue({});
  const muon = {
    getState: vi.fn().mockResolvedValue(state),
    on: vi.fn((event: string, handler: (payload: never) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
    streams: vi.fn().mockResolvedValue([]),
    workspaceReview: vi.fn().mockResolvedValue(WORKSPACE_REVIEW),
    // H2 — the newest wrap packet DECLARES its own missing evidence.
    taskHandoffs: vi.fn().mockResolvedValue({
      omitted: 0,
      items: [
        {
          id: "h-1",
          packetTitle: "Capped the retries",
          packetBody: "…",
          contract: "typed_degraded",
          status: "delivered",
          createdAt: "2026-08-17T08:02:30.000Z",
          fromLane: "codex",
          toLane: null,
          changedFiles: ["src/pay/charge.ts"],
          changedFilesOmitted: 0,
          checks: [],
          degradedReasons: ["tests were not run"],
          diffVerified: false,
        },
      ],
    }),
    // H3 — the certification the dock loads before it will offer Approve.
    reviewApproval: vi.fn().mockResolvedValue({
      status: "certified",
      verdict: "graph-certified",
      changedFiles: ["src/pay/charge.ts"],
      artifactDigest: "b".repeat(64),
    }),
    // The fail-closed desktop ship gate runs on the SAME resolve the dock
    // calls. A resolved-flows verdict lets an approval through; the refusal
    // test below swaps this for a degraded read and asserts the block.
    reviewDiff: vi.fn().mockResolvedValue({
      status: "ok",
      impact: {
        scope: "all",
        totals: {
          changedFiles: 1,
          resolvedFiles: 1,
          blindFiles: 0,
          changedSymbols: 2,
          affectedProcesses: 1,
        },
        blindFiles: [],
        changedSymbols: [],
        affectedProcesses: [],
        coverage: 1,
        indexFreshness: {
          graphCommit: "abc1234",
          headCommit: "abc1234",
          stale: false,
        },
        verdict: "flows-resolved",
        notes: [],
      },
    }),
    autoContext: vi.fn().mockResolvedValue(null),
    getDispatchBudget: vi.fn().mockResolvedValue({
      jobId: "job-root",
      poolMs: 1_800_000,
      reservedMs: 0,
      consumedMs: 0,
      remainingMs: 1_800_000,
      deadlineAt: null,
      childrenIssued: 0,
      maxChildren: 3,
      descendantsIssued: 0,
      maxDescendants: 8,
      depth: 0,
      maxDepth: 3,
      rootWallMs: 1_800_000,
      maxDescendantWallMs: 1_800_000,
      children: [],
    }),
    preEditContext: vi.fn().mockResolvedValue(null),
    dataBoundaries: vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "not under test" }),
    reconMap: vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "not under test" }),
    answerQuestion: vi.fn().mockResolvedValue({ answered: true }),
    resolveApproval,
    shipTask: vi.fn(),
  };
  Object.assign(window, { muon });
  return {
    resolveApproval,
    reviewApproval: muon.reviewApproval,
    emit(event: string, payload: unknown) {
      handlers.get(event)?.(payload as never);
    },
  };
}

/** Open the Review dock the way the existing ship-wiring test does. */
async function openDock(emit: (event: string, payload: unknown) => void) {
  emit("muon:open-approval", { approvalId: "approval-open-dock" });
  await screen.findByRole("dialog", { name: "Approval review" });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Approval review" })).toBeNull()
  );
}

describe("App wiring — the review dock's new decisions are REACHABLE", () => {
  it("H2: a degraded packet reaches the ship control and disables it", async () => {
    const { emit } = mockMuon(desktopState());
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    await openDock(emit);

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    const land = await screen.findByRole("button", { name: /Land this work/ });
    await waitFor(() => expect(land.hasAttribute("disabled")).toBe(true));
    // The refusal names the check the agent did not run — not "looks fine".
    expect(screen.getByText(/tests were not run/)).toBeTruthy();
  });

  it("H3: the pending merge gate is decidable from the Changes dock", async () => {
    const { emit, resolveApproval, reviewApproval } = mockMuon(desktopState());
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    await openDock(emit);

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    const approve = await screen.findByRole("button", {
      name: /Approve merge/,
    });
    // The certification came from the SAME leg the modal uses.
    expect(reviewApproval).toHaveBeenCalledWith("approval-merge");

    fireEvent.click(approve);
    // Straight through the one governed resolve — no second consent path.
    await waitFor(() =>
      expect(resolveApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "approval-merge",
          status: "approved",
        })
      )
    );
  });

  it("H3: the ship gate still refuses through the dock — moving UI is not a grant", async () => {
    // The dock is a new place to press Approve, NOT a new authority. With the
    // graph review unavailable, the same fail-closed gate that guards the modal
    // has to stop this press too, and say so where the operator pressed.
    const { emit, resolveApproval } = mockMuon(desktopState());
    (window as unknown as { muon: Record<string, unknown> }).muon.reviewDiff = vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "index unavailable" });
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    await openDock(emit);

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: /Approve merge/ }));

    expect(await screen.findByText(/Not decided/)).toBeTruthy();
    expect(
      document.querySelector(".merge-section")?.textContent
    ).toMatch(/graph review evidence is unavailable/i);
    expect(resolveApproval).not.toHaveBeenCalled();
  });

  it("H15: an open question is counted and named in the rail", async () => {
    const railCount = () =>
      document.querySelector(".control-rail section header b")?.textContent;

    const { emit } = mockMuon(desktopState());
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    await openDock(emit);

    const line = await waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>(
        '[data-rail-action="focus-questions"]'
      );
      if (!found) throw new Error("no question line in the rail");
      return found;
    });
    expect(line.textContent).toMatch(/Which retry ceiling/);
    const withQuestion = Number(railCount());

    // The same state with the question removed: the badge is exactly one
    // lower, which is the whole claim — a blocked agent counts as needing you.
    cleanup();
    const quiet = desktopState();
    (quiet as { questions: unknown[] }).questions = [];
    const second = mockMuon(quiet);
    render(React.createElement(App));
    await screen.findByText("Cap the retries", { selector: ".chat-title" });
    await openDock(second.emit);
    await waitFor(() =>
      expect(
        document.querySelector('[data-rail-action="focus-questions"]')
      ).toBeNull()
    );
    expect(Number(railCount())).toBe(withQuestion - 1);
  });
});
