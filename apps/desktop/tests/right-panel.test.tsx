// @vitest-environment jsdom

import React, { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceReview } from "../src/shared/ipc.js";
import {
  RightPanel,
  shipReadiness,
  type RightPanelTab,
  type ShipOutcome,
  type ShipPanelProps,
  type ShipTarget,
} from "../src/renderer/right-panel.js";

afterEach(cleanup);

const REVIEW: WorkspaceReview = {
  status: "available",
  workspacePath: "/Users/operator/SWE/MUON-LABS",
  branch: "codex/wave-2",
  stagedFiles: ["src/app.tsx"],
  unstagedFiles: ["src/panels/right-panel.tsx", "README.md"],
  files: ["src/app.tsx", "src/panels/right-panel.tsx", "README.md"],
  stat: "3 files changed, 35 insertions(+), 7 deletions(-)",
  fileStats: [
    { path: "src/app.tsx", additions: 10, deletions: 2, binary: false },
    {
      path: "src/panels/right-panel.tsx",
      additions: 24,
      deletions: 5,
      binary: false,
    },
    { path: "README.md", additions: 1, deletions: 0, binary: false },
  ],
  diffText: "diff --git a/src/app.tsx b/src/app.tsx",
  truncated: false,
  totalBytes: 512,
  maxBytes: 262_144,
};

function RightPanelHarness(props: { reviewLocked?: boolean }) {
  const [activeTab, setActiveTab] = useState<RightPanelTab>("review");
  return (
    <RightPanel
      activeTab={activeTab}
      onTabChange={setActiveTab}
      workspacePath={REVIEW.workspacePath}
      workspaceReview={REVIEW}
      reviewLocked={props.reviewLocked}
      reviewContent={<div data-testid="approval-path">Governed approvals</div>}
    />
  );
}

describe("A2 RightPanel", () => {
  it("provides Files | Changes | Review tabs and renders Review through its React child", () => {
    render(React.createElement(RightPanelHarness));

    expect(screen.getByRole("tab", { name: "Files" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Changes" })).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Review" }).getAttribute("aria-selected")
    ).toBe("true");
    expect(screen.getByTestId("approval-path").textContent).toBe(
      "Governed approvals"
    );
    expect(screen.getByText("codex/wave-2").closest("div")?.textContent).toContain(
      "Branch"
    );
  });

  it("renders the folder tree from the supplied WorkspaceReview without another fetch", () => {
    render(React.createElement(RightPanelHarness));
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));

    expect(screen.getByLabelText("Workspace file tree")).toBeTruthy();
    expect(screen.getByText("src", { selector: "summary span" })).toBeTruthy();
    expect(screen.getByText("panels", { selector: "summary span" })).toBeTruthy();
    expect(
      screen.getByText("right-panel.tsx").closest("li")?.textContent
    ).toContain("+24");
    expect(screen.queryByTestId("approval-path")).toBeNull();
  });

  it("renders staged and unstaged sections from the existing workspace review", () => {
    render(React.createElement(RightPanelHarness));
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));

    expect(screen.getByText("Combined working tree")).toBeTruthy();
    expect(
      screen.getByText(/line totals and the bounded diff are combined against HEAD/i)
    ).toBeTruthy();
    expect(screen.getByText(/^Staged$/i)).toBeTruthy();
    expect(screen.getByText(/^Unstaged$/i)).toBeTruthy();
    expect(screen.getByText("src/app.tsx")).toBeTruthy();
    expect(screen.getByText("src/panels/right-panel.tsx")).toBeTruthy();
    expect(screen.getByText("+35")).toBeTruthy();
    expect(screen.getByText("−7")).toBeTruthy();
  });

  it("keeps Review selected while a governed approval dialog is focused", () => {
    const onTabChange = vi.fn();
    render(
      React.createElement(RightPanel, {
        activeTab: "review",
        onTabChange,
        workspacePath: REVIEW.workspacePath,
        workspaceReview: REVIEW,
        reviewLocked: true,
        reviewContent: React.createElement("div", null, "Approval review"),
      })
    );

    expect(
      screen.getByRole("tab", { name: "Files" }).hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen.getByRole("tab", { name: "Changes" }).hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen.getByRole("tab", { name: "Review" }).hasAttribute("disabled")
    ).toBe(false);
  });

  it("shows the branch PR/checks and opens only through the supplied main-process callback", () => {
    const onOpenGitHubUrl = vi.fn();
    render(
      React.createElement(RightPanel, {
        activeTab: "review",
        onTabChange: vi.fn(),
        workspacePath: REVIEW.workspacePath,
        workspaceReview: REVIEW,
        githubConnected: true,
        githubReview: {
          status: "available",
          repository: { owner: "muon", repo: "muon" },
          branch: "codex/wave-2",
          pullRequest: {
            number: 42,
            title: "Ship the review dock",
            url: "https://github.com/muon/muon/pull/42",
            headSha: "abcdef1234567890",
            author: "operator",
            draft: false,
            updatedAt: "2026-07-21T12:00:00.000Z",
          },
          checks: {
            state: "pending",
            total: 2,
            passed: 1,
            pending: 1,
            failed: 0,
            neutral: 0,
            unavailable: false,
            items: [
              {
                name: "unit",
                source: "check-run",
                state: "success",
                status: "completed",
                conclusion: "success",
              },
              {
                name: "integration",
                source: "check-run",
                state: "pending",
                status: "in_progress",
              },
            ],
          },
        },
        onOpenGitHubUrl,
        reviewContent: React.createElement(
          "div",
          { "data-testid": "approval-path" },
          "Governed approvals"
        ),
      })
    );

    expect(screen.getByText("Ship the review dock")).toBeTruthy();
    expect(screen.getByText(/1 passed · 1 pending · 0 failed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open PR" }));
    expect(onOpenGitHubUrl).toHaveBeenCalledWith(
      "https://github.com/muon/muon/pull/42"
    );
    expect(screen.getByTestId("approval-path")).toBeTruthy();
  });

  it("creates a PR only through the supplied governed callback", async () => {
    const onCreateGitHubPullRequest = vi.fn().mockResolvedValue({
      operation: "created",
      review: {
        status: "available",
        repository: { owner: "muon", repo: "muon" },
        branch: "codex/wave-2",
        pullRequest: {
          number: 42,
          title: "Ship governed publishing",
          url: "https://github.com/muon/muon/pull/42",
          headSha: "abcdef1234567890",
          draft: false,
          updatedAt: "2026-07-21T12:00:00.000Z",
        },
        checks: {
          state: "none",
          total: 0,
          passed: 0,
          pending: 0,
          failed: 0,
          neutral: 0,
          unavailable: false,
          items: [],
        },
      },
    });
    render(
      React.createElement(RightPanel, {
        activeTab: "review",
        onTabChange: vi.fn(),
        workspacePath: REVIEW.workspacePath,
        workspaceReview: REVIEW,
        githubConnected: true,
        githubReview: {
          status: "no_pull_request",
          repository: { owner: "muon", repo: "muon" },
          branch: "codex/wave-2",
        },
        onCreateGitHubPullRequest,
        reviewContent: null,
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    await waitFor(() =>
      expect(onCreateGitHubPullRequest).toHaveBeenCalledTimes(1)
    );
    expect(await screen.findByText(/Pull request #42 created/i)).toBeTruthy();
    expect(screen.getByText(/durable governed merge/i)).toBeTruthy();
  });

  it("keeps merge locked until checks are green and sends the reviewed head", async () => {
    const onMergeGitHubPullRequest = vi.fn().mockResolvedValue({
      operation: "merged",
      pullNumber: 42,
      sha: "1234567890abcdef",
      message: "Pull Request successfully merged",
    });
    const available = {
      status: "available" as const,
      repository: { owner: "muon", repo: "muon" },
      branch: "codex/wave-2",
      pullRequest: {
        number: 42,
        title: "Ship governed publishing",
        url: "https://github.com/muon/muon/pull/42",
        headSha: "abcdef1234567890",
        author: "operator",
        draft: false,
        updatedAt: "2026-07-21T12:00:00.000Z",
      },
      checks: {
        state: "pending" as const,
        total: 1,
        passed: 0,
        pending: 1,
        failed: 0,
        neutral: 0,
        unavailable: false,
        items: [
          {
            name: "unit",
            source: "check-run" as const,
            state: "pending" as const,
            status: "in_progress",
          },
        ],
      },
    };
    const panel = (review: typeof available) =>
      React.createElement(RightPanel, {
        activeTab: "review" as RightPanelTab,
        onTabChange: vi.fn(),
        workspacePath: REVIEW.workspacePath,
        workspaceReview: REVIEW,
        githubConnected: true,
        githubReview: review,
        onMergeGitHubPullRequest,
        reviewContent: null,
      });
    const { rerender } = render(panel(available));

    expect(
      screen.getByRole("button", { name: "Merge PR" }).hasAttribute("disabled")
    ).toBe(true);
    rerender(
      panel({
        ...available,
        checks: {
          ...available.checks,
          state: "success",
          passed: 1,
          pending: 0,
          items: [
            {
              name: "unit",
              source: "check-run",
              state: "success",
              status: "completed",
              conclusion: "success",
            },
          ],
        },
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Merge PR" }));

    await waitFor(() =>
      expect(onMergeGitHubPullRequest).toHaveBeenCalledWith({
        pullNumber: 42,
        expectedHeadSha: "abcdef1234567890",
      })
    );
    expect(await screen.findByText(/merged as 1234567/i)).toBeTruthy();
  });
});

// ─── LANDING A GOVERNED CHILD'S WORK FROM THE CHANGES PANEL ──────────────────
//
// The regression these guard: a child did real work in `.muon/worktrees/<task>`,
// this panel rendered its diff, and there was no way to land it — so the work
// was stranded unless the AGENT happened to call MCP `ship`.

const WORKTREE: ShipTarget = {
  jobId: "job-1",
  taskId: "task-1",
  laneKey: "codex",
  status: "done",
  tree: {
    status: "resolved",
    kind: "worktree",
    path: "/Users/operator/SWE/MUON-LABS/.muon/worktrees/task-1",
  },
  gateBlockReason: null,
};

function renderShip(
  target: ShipTarget | null,
  onShip: ShipPanelProps["onShip"] = vi.fn(),
  over: {
    review?: WorkspaceReview | null;
    loading?: boolean;
    outcome?: ShipOutcome | null;
  } = {}
) {
  return render(
    React.createElement(RightPanel, {
      activeTab: "changes" as RightPanelTab,
      onTabChange: vi.fn(),
      workspacePath: REVIEW.workspacePath,
      workspaceReview: over.review === undefined ? REVIEW : over.review,
      loading: over.loading,
      ship: { target, onShip, outcome: over.outcome },
      reviewContent: null,
    })
  );
}

const landButton = () => screen.getByRole("button", { name: "Land this work" });

describe("Changes panel — governed landing", () => {
  it("files the SAME governed merge payload the CLI `muon ship` files", async () => {
    const onShip = vi
      .fn()
      .mockResolvedValue({ approvalId: "approval-9", pending: true });
    renderShip(WORKTREE, onShip);

    fireEvent.click(landButton());

    await waitFor(() => expect(onShip).toHaveBeenCalledTimes(1));
    const request = onShip.mock.calls[0]![0];
    expect(request.kind).toBe("merge");
    expect(request.taskId).toBe("task-1");
    expect(request.requestedBy).toBe("codex");
    expect(request.jobId).toBe("job-1");
    expect(request.reason.length).toBeLessThanOrEqual(300);
    // Honest provenance: the desktop ran no checks and must not claim it did.
    expect(request.reason).toMatch(/MUON desktop/);
    expect(request.reason).toMatch(/no automated checks were run/);
    expect(request.reason).not.toMatch(/passed/);
  });

  it("a filed gate says nothing has landed yet, and names the gate to decide", async () => {
    renderShip(
      WORKTREE,
      vi.fn().mockResolvedValue({ approvalId: "approval-9", pending: true })
    );
    fireEvent.click(landButton());

    expect(
      await screen.findByText(/Nothing has landed yet/i)
    ).toBeTruthy();
    expect(screen.getByText("approval-9")).toBeTruthy();
  });

  it("does not offer to file a SECOND gate for the same task once one exists", async () => {
    const onShip = vi
      .fn()
      .mockResolvedValue({ approvalId: "approval-9", pending: true });
    renderShip(WORKTREE, onShip);
    fireEvent.click(landButton());

    await screen.findByText(/Nothing has landed yet/i);
    expect(screen.queryByRole("button", { name: "Land this work" })).toBeNull();
    expect(onShip).toHaveBeenCalledTimes(1);
  });

  it("keeps the button after a REFUSAL so a genuine retry is possible", async () => {
    const onShip = vi.fn().mockRejectedValue(new Error("brain unreachable"));
    renderShip(WORKTREE, onShip);
    fireEvent.click(landButton());

    await screen.findByText("brain unreachable");
    expect(landButton()).toBeTruthy();
  });

  it("a landed merge reports its commit sha, never a bare 'approved'", async () => {
    const outcome: ShipOutcome = {
      approvalId: "approval-9",
      pending: false,
      merge: {
        status: "merged",
        sha: "0123456789abcdef0123456789abcdef01234567",
        changedFiles: 3,
        mergeCommit: "fedcba9876543210fedcba9876543210fedcba98",
      },
    };
    renderShip(WORKTREE, vi.fn().mockResolvedValue(outcome));
    fireEvent.click(landButton());

    const landed = await screen.findByText(/Landed as/i);
    expect(landed.textContent).toContain("0123456");
    expect(landed.textContent).toContain("3 files");
    expect(screen.getByText(/Merge commit/i).textContent).toContain("fedcba9");
  });

  it("a refused merge renders the refusal's own reason", async () => {
    renderShip(
      WORKTREE,
      vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Merge not executed (conflict): git merge --no-ff left conflicts in src/app.tsx."
          )
        )
    );
    fireEvent.click(landButton());

    expect(await screen.findByText(/Not landed/i)).toBeTruthy();
    expect(
      screen.getByText(/left conflicts in src\/app\.tsx/i)
    ).toBeTruthy();
  });

  it("a merge the brain reports as blocked/conflicted says nothing was landed, with the reason", async () => {
    renderShip(
      WORKTREE,
      vi.fn().mockResolvedValue({
        approvalId: "approval-9",
        pending: false,
        merge: {
          status: "blocked",
          reason:
            "The primary checkout changed branches after review. Refresh review on the intended branch and approve again.",
        },
      } satisfies ShipOutcome)
    );
    fireEvent.click(landButton());

    expect(
      await screen.findByText(/Merge refused — nothing was landed/i)
    ).toBeTruthy();
    expect(screen.getByText(/changed branches after review/i)).toBeTruthy();
  });

  it("a decided gate with NO merge outcome refuses to imply the work landed", async () => {
    renderShip(
      WORKTREE,
      vi
        .fn()
        .mockResolvedValue({ approvalId: "approval-9", pending: false })
    );
    fireEvent.click(landButton());

    expect(
      await screen.findByText(/the merge result is unknown/i)
    ).toBeTruthy();
    expect(
      screen.getByText(/Check the branch before assuming this work landed/i)
    ).toBeTruthy();
  });

  it("a LATER Full Auto decision overrides the 'filed, nothing landed yet' line", async () => {
    // Full Auto decides the gate after `onShip` has already resolved pending.
    const onShip = vi
      .fn()
      .mockResolvedValue({ approvalId: "approval-9", pending: true });
    const { rerender } = renderShip({ ...WORKTREE, fullAuto: true }, onShip);
    fireEvent.click(landButton());
    await screen.findByText(/Nothing has landed yet/i);

    rerender(
      React.createElement(RightPanel, {
        activeTab: "changes" as RightPanelTab,
        onTabChange: vi.fn(),
        workspacePath: REVIEW.workspacePath,
        workspaceReview: REVIEW,
        ship: {
          target: { ...WORKTREE, fullAuto: true },
          onShip,
          outcome: {
            approvalId: "approval-9",
            pending: false,
            merge: {
              status: "merged",
              sha: "0123456789abcdef0123456789abcdef01234567",
              changedFiles: 3,
            },
          },
        },
        reviewContent: null,
      })
    );

    expect(screen.queryByText(/Nothing has landed yet/i)).toBeNull();
    expect(screen.getByText(/Landed as/i).textContent).toContain("0123456");
  });

  it("states the governance in force instead of landing silently", () => {
    const { unmount } = renderShip(WORKTREE);
    expect(
      screen.getByText(/Nothing lands until you approve it in Review/i)
    ).toBeTruthy();
    unmount();

    renderShip({ ...WORKTREE, fullAuto: true });
    expect(
      screen.getByText(/Full Auto holds the standing consent/i)
    ).toBeTruthy();
  });

  it("renders no land affordance at all when the panel is not wired for shipping", () => {
    render(
      React.createElement(RightPanel, {
        activeTab: "changes" as RightPanelTab,
        onTabChange: vi.fn(),
        workspacePath: REVIEW.workspacePath,
        workspaceReview: REVIEW,
        reviewContent: null,
      })
    );
    expect(screen.queryByRole("button", { name: "Land this work" })).toBeNull();
    expect(screen.queryByText("Land this work")).toBeNull();
  });
});

describe("Changes panel — each 'cannot land' state gets its own sentence", () => {
  const noButton = () =>
    expect(screen.queryByRole("button", { name: "Land this work" })).toBeNull();

  it("no dispatch selected", () => {
    renderShip(null);
    noButton();
    expect(screen.getByText(/No dispatch is selected/i)).toBeTruthy();
  });

  it("no resolvable tree — repeats job-tree's own typed reason and action", () => {
    renderShip({
      ...WORKTREE,
      tree: {
        status: "unresolved",
        reason:
          "This dispatch ran in the isolated worktree '/repo/.muon/worktrees/task-1', which is not on disk now.",
        action:
          "A merged or pruned worktree is removed after it lands. Review the landed commit on the branch, or re-dispatch to rebuild it.",
      },
    });
    noButton();
    expect(screen.getByText(/which is not on disk now/i)).toBeTruthy();
    expect(screen.getByText(/or re-dispatch to rebuild it/i)).toBeTruthy();
  });

  it("the dispatch ran in the primary checkout, so there is no child tree to merge", () => {
    renderShip({
      ...WORKTREE,
      tree: {
        status: "resolved",
        kind: "workspace",
        path: "/Users/operator/SWE/MUON-LABS",
      },
    });
    noButton();
    expect(
      screen.getByText(/ran directly in the primary checkout/i)
    ).toBeTruthy();
  });

  it("the dispatch is not terminal", () => {
    renderShip({ ...WORKTREE, status: "running" });
    noButton();
    expect(
      screen.getByText(/still running, so its work is not finished/i)
    ).toBeTruthy();
    expect(
      screen.getByText(/done, failed, or interrupted/i)
    ).toBeTruthy();
  });

  it("the tree is empty", () => {
    renderShip(WORKTREE, vi.fn(), {
      review: {
        ...REVIEW,
        files: [],
        stagedFiles: [],
        unstagedFiles: [],
        fileStats: [],
      },
    });
    noButton();
    expect(screen.getByText(/no changes against HEAD/i)).toBeTruthy();
    expect(
      screen.getByText(/confirm the agent wrote into/i).textContent
    ).toContain(".muon/worktrees/task-1");
  });

  it("the ship gate is unsatisfied — the gate's own words, not a generic block", () => {
    renderShip({
      ...WORKTREE,
      gateBlockReason:
        "Can't ship — REVIEW BLIND: 1/2 changed file(s) are not in the graph. Re-index or review the blind files, then approve.",
    });
    noButton();
    expect(screen.getByText(/REVIEW BLIND/)).toBeTruthy();
    expect(screen.getByText(/Re-index or review the blind files/i)).toBeTruthy();
  });

  it("the workspace review is degraded — never files a gate over an unread tree", () => {
    renderShip(WORKTREE, vi.fn(), {
      review: {
        status: "degraded",
        reason: "git is not on PATH.",
        action: "Install git, then retry.",
      },
    });
    noButton();
    expect(screen.getByText(/what would land is unknown/i).textContent).toContain(
      "git is not on PATH."
    );
    // The recovery action is stated ONCE, by the degraded callout below.
    expect(screen.getAllByText("Install git, then retry.")).toHaveLength(1);
  });

  it("the tree is still loading", () => {
    renderShip(WORKTREE, vi.fn(), { loading: true, review: null });
    noButton();
    expect(screen.getByText(/Reading the tree/i)).toBeTruthy();
  });
});

describe("shipReadiness — the decision behind the affordance", () => {
  it("admits only a terminal, non-empty, gate-clear task worktree", () => {
    const ready = shipReadiness({
      target: WORKTREE,
      review: REVIEW,
      loading: false,
    });
    expect(ready.can).toBe(true);
  });

  it("reports the missing tree BEFORE the gate — the operator gets the actionable fact", () => {
    const blocked = shipReadiness({
      target: {
        ...WORKTREE,
        gateBlockReason: "Can't ship — REVIEW BLIND: …",
        tree: {
          status: "unresolved",
          reason: "This dispatch has no workspace path.",
          action: "Re-dispatch the task with an explicit workspace.",
        },
      },
      review: REVIEW,
      loading: false,
    });
    expect(blocked.can).toBe(false);
    expect(blocked.can === false && blocked.sentence).toMatch(
      /no workspace path/
    );
  });

  it("does not claim a gate verdict it was never given (undefined ≠ blocked)", () => {
    const ready = shipReadiness({
      target: { ...WORKTREE, gateBlockReason: undefined },
      review: REVIEW,
      loading: false,
    });
    // Filing is still governed: the note says the gate decides, and the backend
    // + approval dialog enforce it regardless of what this panel knew.
    expect(ready.can).toBe(true);
    expect(ready.can === true && ready.note).toMatch(/Nothing lands until you approve/i);
  });
});
