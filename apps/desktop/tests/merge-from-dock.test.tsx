// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RightPanel, type DockMergeProps } from "../src/renderer/right-panel.js";
import type { ApprovalRequest, ReviewCoverageCertification } from "@muon/client";
import type { WorkspaceReview } from "../src/shared/ipc.js";

afterEach(cleanup);

/**
 * ROADMAP H3 — decide the merge gate from the dock that reviewed the diff.
 *
 * What must stay true after moving UI ownership: the dock cannot approve
 * anything the modal would have refused. Every test below is a statement about
 * AUTHORITY (who may approve, on what evidence) rather than about layout — the
 * one exception being the routing test, which pins that the REVIEW BLIND
 * attestation is NOT reimplemented here.
 */

const REVIEW: WorkspaceReview = {
  status: "available",
  workspacePath: "/repo",
  branch: "codex/wave-2",
  stagedFiles: ["src/pay/charge.ts"],
  unstagedFiles: [],
  files: ["src/pay/charge.ts"],
  stat: "1 file changed",
  fileStats: [
    { path: "src/pay/charge.ts", additions: 3, deletions: 0, binary: false },
  ],
  diffText: "diff --git a/src/pay/charge.ts b/src/pay/charge.ts",
  truncated: false,
  totalBytes: 128,
  maxBytes: 262_144,
  tree: { kind: "worktree", path: "/repo/.muon/worktrees/task-1" },
} as WorkspaceReview;

const MERGE_APPROVAL: ApprovalRequest = {
  id: "approval-merge-1",
  taskId: "task-1",
  requestedBy: "codex",
  kind: "merge",
  reason: "ship requested from MUON desktop: 1 file changed (+3/−0)",
  status: "pending",
};

const DIGEST = "a".repeat(64);

const CERTIFIED: ReviewCoverageCertification = {
  status: "certified",
  verdict: "graph-certified",
  changedFiles: ["src/pay/charge.ts"],
  artifactDigest: DIGEST,
};

const REVIEW_BLIND: ReviewCoverageCertification = {
  status: "blocked",
  blockCode: "review-blind",
  reason: "1/1 changed file(s) are not in the graph.",
  blindFiles: ["src/pay/charge.ts"],
  changedFiles: ["src/pay/charge.ts"],
  artifactDigest: DIGEST,
};

function renderDock(merge: Partial<DockMergeProps> = {}) {
  const props: DockMergeProps = {
    approval: MERGE_APPROVAL,
    loadCertification: vi.fn(async () => CERTIFIED),
    onResolve: vi.fn(async () => undefined),
    onOpenEvidence: vi.fn(),
    ...merge,
  };
  render(
    <RightPanel
      activeTab="changes"
      onTabChange={vi.fn()}
      workspacePath="/repo"
      workspaceReview={REVIEW}
      merge={props}
      reviewContent={null}
    />
  );
  return props;
}

const approveButton = () =>
  document.querySelector<HTMLButtonElement>('[data-merge-action="approve"]');
const rejectButton = () =>
  document.querySelector<HTMLButtonElement>('[data-merge-action="reject"]');
const evidenceButton = () =>
  document.querySelector<HTMLButtonElement>('[data-merge-action="evidence"]');

describe("H3 — the dock renders the gate's certification", () => {
  it("loads certification through the SAME leg the dialog uses, and names it", async () => {
    const props = renderDock();
    expect(await screen.findByText(/Certified/)).toBeTruthy();
    expect(props.loadCertification).toHaveBeenCalledWith("approval-merge-1");
    // The gate's own audit reason rides on screen, verbatim.
    expect(
      document.querySelector(".merge-section")?.textContent
    ).toContain(MERGE_APPROVAL.reason);
  });

  it("renders nothing at all when this task has no pending merge gate", () => {
    renderDock({ approval: null });
    expect(document.querySelector(".merge-section")).toBeNull();
  });

  it("shows the loading state before evidence lands — never a bare Approve", () => {
    renderDock({
      loadCertification: vi.fn(
        () => new Promise<ReviewCoverageCertification>(() => {})
      ),
    });
    expect(screen.getByText(/Checking this exact worktree/i)).toBeTruthy();
    expect(approveButton(), "unproven work has no Approve").toBeNull();
  });
});

describe("H3 — approving stays fail-closed, and goes through the ONE resolve", () => {
  it("a certified gate approves through onResolveApproval with the approval id", async () => {
    const props = renderDock();
    fireEvent.click(await screen.findByRole("button", { name: /Approve merge/ }));
    await vi.waitFor(() =>
      expect(props.onResolve).toHaveBeenCalledWith("approval-merge-1", "approved")
    );
  });

  it("offers NO approve button when certification is blocked", async () => {
    renderDock({ loadCertification: vi.fn(async () => REVIEW_BLIND) });
    await screen.findByText(/Not certified/i);
    expect(approveButton()).toBeNull();
  });

  it("offers NO approve button when the certification READ failed", async () => {
    // An unreadable certification is not a passed one.
    renderDock({
      loadCertification: vi.fn(async () => {
        throw new Error("brain unreachable");
      }),
    });
    expect(await screen.findByText(/brain unreachable/)).toBeTruthy();
    expect(approveButton()).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("offers NO approve button on a preload with no review surface", async () => {
    renderDock({ loadCertification: undefined });
    expect(await screen.findByText(/Merge review is unavailable/i)).toBeTruthy();
    expect(approveButton()).toBeNull();
  });

  it("REJECT is never blocked by missing evidence", async () => {
    const props = renderDock({ loadCertification: vi.fn(async () => REVIEW_BLIND) });
    await screen.findByText(/Not certified/i);
    fireEvent.click(rejectButton()!);
    await vi.waitFor(() =>
      expect(props.onResolve).toHaveBeenCalledWith("approval-merge-1", "rejected")
    );
  });
});

describe("H3 — review-blind routes to the dialog that owns attestation", () => {
  it("shows the block and offers a route, not a second attestation flow", async () => {
    const props = renderDock({
      loadCertification: vi.fn(async () => REVIEW_BLIND),
    });
    expect(await screen.findByText(/REVIEW BLIND/)).toBeTruthy();
    // The blind file itself is named IN THE GATE SECTION, so the operator
    // knows what to go read (the changed-file list elsewhere on the tab is a
    // different claim — "this changed", not "the graph cannot see this").
    const section = document.querySelector(".merge-section")!;
    expect(section.textContent).toContain("src/pay/charge.ts");
    expect(section.textContent).toMatch(/1 blind file/);
    // No checkbox, no "I reviewed these" control: attestation lives in ONE
    // place, and duplicating it is how the two copies come to disagree.
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    fireEvent.click(evidenceButton()!);
    expect(props.onOpenEvidence).toHaveBeenCalledWith("approval-merge-1");
    expect(props.onResolve).not.toHaveBeenCalled();
  });
});

describe("H3 — a refused decision says why, on this screen", () => {
  it("surfaces the ship gate's own refusal sentence inline", async () => {
    const props = renderDock({
      onResolve: vi.fn(async () => {
        throw new Error(
          "Can't ship — REVIEW BLIND: changed files are unindexed, so 0 affected flows is not a pass."
        );
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /Approve merge/ }));
    expect(await screen.findByText(/0 affected flows is not a pass/)).toBeTruthy();
    expect(props.onResolve).toHaveBeenCalledTimes(1);
  });

  it("a refusal with no message still says something true", async () => {
    renderDock({
      onResolve: vi.fn(async () => {
        throw new Error("   ");
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /Approve merge/ }));
    expect(await screen.findByText(/no reason was returned/i)).toBeTruthy();
  });
});

describe("H3 — Full Auto keeps its single consent path", () => {
  it("shows evidence and NO click site when standing consent owns the gate", async () => {
    renderDock({ autoApproving: true });
    await screen.findByText(/Certified/);
    expect(approveButton()).toBeNull();
    expect(rejectButton()).toBeNull();
    expect(screen.getByText(/Full Auto is granting this gate/i)).toBeTruthy();
  });
});
