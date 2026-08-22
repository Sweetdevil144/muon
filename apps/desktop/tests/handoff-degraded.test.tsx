// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HandoffPanel } from "../src/renderer/handoff-panel.js";
import { RightPanel } from "../src/renderer/right-panel.js";
import {
  buildDockShipTarget,
  handoffShipBlockReason,
} from "../src/renderer/lib/dock-ship-target.js";
import { describeHandoffDegradation } from "@muon/client/handoff-view";
import type {
  TaskHandoffPage,
  TaskHandoffView,
  WorkspaceReview,
} from "../src/shared/ipc.js";

afterEach(cleanup);

/**
 * ROADMAP H2 — "degraded is as loud as fail", desktop half.
 *
 * The property under test is never a sentence, it is a RANK: a packet MUON
 * cannot vouch for must not be able to pass for a clean one anywhere the
 * operator looks — not on a closed disclosure, not on a card, and above all not
 * on the control that files a merge gate. Assertions are by intent (see
 * ship-gate.test.ts:36-41): they pin "the missing check is named" and "the
 * button is not clickable", never the exact wording.
 */

function open() {
  const details = document.querySelector("details.handoff-panel");
  if (!details) throw new Error("handoff panel is not rendered");
  (details as HTMLDetailsElement).open = !(details as HTMLDetailsElement).open;
  fireEvent(details, new Event("toggle", { bubbles: false }));
}

function view(overrides: Partial<TaskHandoffView> = {}): TaskHandoffView {
  return {
    id: "h-1",
    packetTitle: "Implemented the retry cap",
    packetBody: "Changed charge() to cap retries at 30s.",
    contract: "typed",
    status: "delivered",
    createdAt: "2026-08-11T00:00:00.000Z",
    fromLane: "codex",
    toLane: "claude-code",
    changedFiles: ["src/pay/charge.ts"],
    changedFilesOmitted: 0,
    checks: [{ name: "tests", outcome: "passed" }],
    degradedReasons: [],
    diffVerified: true,
    ...overrides,
  };
}

function page(items: TaskHandoffView[], omitted = 0): TaskHandoffPage {
  return { items, omitted };
}

const DEGRADED = view({
  id: "h-degraded",
  contract: "typed_degraded",
  degradedReasons: ["no diff evidence captured", "tests were not run"],
  checks: [],
  diffVerified: false,
});

describe("H2 — the panel ranks a degraded packet with the failures", () => {
  it("names the missing evidence ALWAYS, not tucked inside a disclosure", async () => {
    render(
      <HandoffPanel taskId="task-1" load={vi.fn(async () => page([DEGRADED]))} />
    );
    open();
    // The two declared reasons reach the operator on the open panel...
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no diff evidence captured/);
    expect(alert.textContent).toMatch(/tests were not run/);
    // ...as an ALERT, which is the attention rank a failure gets, and it is not
    // nested in a <details> the reader has to think to open.
    expect(alert.closest("details.handoff-panel")).toBeTruthy();
    expect(
      alert.parentElement?.closest("details"),
      "the reasons must not be hidden behind a second disclosure"
    ).toBe(document.querySelector("details.handoff-panel"));
  });

  it("marks the card and the contract line, so the rank is visible at a glance", async () => {
    render(
      <HandoffPanel taskId="task-1" load={vi.fn(async () => page([DEGRADED]))} />
    );
    open();
    await screen.findByRole("alert");
    expect(document.querySelector(".handoff-card.degraded")).toBeTruthy();
    expect(
      document.querySelector(".handoff-contract.degraded")?.textContent
    ).toMatch(/⚠/);
  });

  it("a packet that FAILED VALIDATION still says what is missing, with no reasons to quote", async () => {
    // The trap this closes: `packet_parse_failed` carries an empty
    // `degradedReasons` (there is no parsed packet to read them from), so a
    // reasons-only line rendered NOTHING for the least trustworthy contract of
    // the four — the loudest packet was the quietest row on screen.
    render(
      <HandoffPanel
        taskId="task-1"
        load={vi.fn(async () =>
          page([view({ contract: "packet_parse_failed", degradedReasons: [] })])
        )}
      />
    );
    open();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/missing evidence/i);
    expect(alert.textContent).toMatch(/could not be read|failed validation/i);
  });

  it("a self-flagged packet with NO stated reason is still loud", () => {
    const said = describeHandoffDegradation({
      contract: "typed_degraded",
      degradedReasons: [],
    });
    expect(said).toBeTruthy();
    expect(said).toMatch(/unrun|names no reason/i);
  });

  it("leaves a clean typed packet alone — no alarm, no borrowed chrome", async () => {
    render(<HandoffPanel taskId="task-1" load={vi.fn(async () => page([view()]))} />);
    open();
    expect(await screen.findByText("Implemented the retry cap")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector(".handoff-card.degraded")).toBeNull();
  });

  it("keeps a NON-degraded packet's own caveats, without the alarm", async () => {
    // `{flag:false, reasons:[…]}` is representable, so a packet can list
    // caveats while denying it is degraded. Dropping them would lose real
    // information; promoting them to the alarm would let the packet's prose
    // outrank MUON's classification. It gets neither treatment: it gets both
    // halves of the truth.
    render(
      <HandoffPanel
        taskId="task-1"
        load={vi.fn(async () =>
          page([view({ contract: "typed", degradedReasons: ["checks_truncated"] })])
        )}
      />
    );
    open();
    expect(await screen.findByText(/checks_truncated/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector(".handoff-card.degraded")).toBeNull();
  });

  it("counts degraded rows SEPARATELY on the closed disclosure", async () => {
    render(
      <HandoffPanel
        taskId="task-1"
        load={vi.fn(async () => page([DEGRADED, view({ id: "h-2" })]))}
      />
    );
    open();
    const count = await screen.findByText(/2 handoffs/);
    // A human who never opens the panel still learns one of them is degraded.
    expect(count.textContent).toMatch(/1 degraded/);
    expect(count.className).toMatch(/degraded/);
  });

  it("says nothing about degradation when there is none to report", async () => {
    render(
      <HandoffPanel
        taskId="task-1"
        load={vi.fn(async () => page([view(), view({ id: "h-2" })]))}
      />
    );
    open();
    const count = await screen.findByText(/2 handoffs/);
    expect(count.textContent).not.toMatch(/degraded/);
  });

  it("the bound's omission note does NOT borrow the degradation alarm", async () => {
    // If "+7 older handoffs not shown" wears the same loud style, the style
    // stops meaning "this work is unverified".
    render(
      <HandoffPanel taskId="task-1" load={vi.fn(async () => page([view()], 7))} />
    );
    open();
    expect(await screen.findByText(/\+7 older handoffs not/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("H2 — a degraded packet refuses the ship control", () => {
  it("names the missing evidence in the refusal, never 'looks fine'", () => {
    const reason = handoffShipBlockReason(DEGRADED);
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/no diff evidence captured/);
    expect(reason).toMatch(/tests were not run/);
    // And a lawful way forward, asserted by intent rather than exact prose.
    expect(reason).toMatch(/wrap again|re-run/i);
    expect(reason).not.toMatch(/looks fine/i);
  });

  it("a clean packet, and no packet at all, raise no objection", () => {
    expect(handoffShipBlockReason(view())).toBeNull();
    // A task that never wrapped is governed by the merge gate, not by this
    // line — inventing a block here would make "never wrapped" unshippable.
    expect(handoffShipBlockReason(null)).toBeNull();
    expect(handoffShipBlockReason(undefined)).toBeNull();
  });

  it("obeys the NEWEST packet — an older clean one cannot un-degrade it", () => {
    expect(handoffShipBlockReason(DEGRADED)).toBeTruthy();
    const target = buildDockShipTarget({
      job: { id: "job-1", taskId: "task-1", vendor: "codex", status: "done" } as never,
      review: null,
      fullAuto: false,
      // newest-first, exactly as `projectHandoffPage` returns them
      handoffs: [DEGRADED, view()],
    });
    expect(target?.gateBlockReason).toMatch(/no diff evidence captured/);
  });

  it("dockShipTarget populates gateBlockReason from a degraded packet", () => {
    const target = buildDockShipTarget({
      job: { id: "job-1", taskId: "task-1", vendor: "codex", status: "done" } as never,
      review: null,
      fullAuto: false,
      handoffs: [DEGRADED],
    });
    expect(target?.gateBlockReason).toBeTruthy();
    expect(target?.gateBlockReason).toMatch(/degraded/i);
  });

  it("an UNREAD handoff page is not a block — absence of a read is not evidence", () => {
    const target = buildDockShipTarget({
      job: { id: "job-1", taskId: "task-1", vendor: "codex", status: "done" } as never,
      review: null,
      fullAuto: false,
      handoffs: null,
    });
    expect(target?.gateBlockReason).toBeNull();
  });

  it("no dispatch means no target at all, never a half-built one", () => {
    expect(
      buildDockShipTarget({ job: null, review: null, fullAuto: false })
    ).toBeNull();
  });
});

const REVIEW: WorkspaceReview = {
  status: "available",
  workspacePath: "/repo",
  branch: "codex/wave-2",
  stagedFiles: ["src/pay/charge.ts"],
  unstagedFiles: [],
  files: ["src/pay/charge.ts"],
  stat: "1 file changed, 3 insertions(+)",
  fileStats: [
    { path: "src/pay/charge.ts", additions: 3, deletions: 0, binary: false },
  ],
  diffText: "diff --git a/src/pay/charge.ts b/src/pay/charge.ts",
  truncated: false,
  totalBytes: 128,
  maxBytes: 262_144,
  tree: { kind: "worktree", path: "/repo/.muon/worktrees/task-1" },
} as WorkspaceReview;

function renderChanges(gateBlockReason: string | null) {
  render(
    <RightPanel
      activeTab="changes"
      onTabChange={vi.fn()}
      workspacePath="/repo"
      workspaceReview={REVIEW}
      ship={{
        target: {
          jobId: "job-1",
          taskId: "task-1",
          laneKey: "codex",
          status: "done",
          tree: {
            status: "resolved",
            kind: "worktree",
            path: "/repo/.muon/worktrees/task-1",
          },
          gateBlockReason,
        },
        onShip: vi.fn(),
      }}
      reviewContent={null}
    />
  );
}

describe("H2 — ShipSection keeps the control on screen, disabled, with the reason", () => {
  it("disables 'Land this work' and states the missing evidence beside it", () => {
    renderChanges(
      "Can't land this work — the newest handoff packet is degraded. Missing evidence: tests were not run."
    );
    const button = screen.getByRole("button", { name: "Land this work" });
    // Not merely hidden: an operator who came here to land work sees the
    // control being WITHHELD, and why, instead of hunting for a vanished button.
    expect(button.hasAttribute("disabled")).toBe(true);
    const block = screen.getByRole("alert");
    expect(block.textContent).toMatch(/tests were not run/);
  });

  it("offers the real button again once the evidence objection is gone", () => {
    renderChanges(null);
    const button = screen.getByRole("button", { name: "Land this work" });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
