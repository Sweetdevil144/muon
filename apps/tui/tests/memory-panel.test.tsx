import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { MemoryNote } from "@muon/client";
import { MemoryPanel } from "../src/components/MemoryPanel.js";

// R3 TTL in the TUI. Same governed read as the desktop's "Show expired"
// toggle: expired hidden by default, a key to flip the posture, and a marker
// that says a row is lapsed rather than letting it disappear silently.

function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem-1",
    kind: "decision",
    text: "Authorization stays deny-by-default.",
    taskId: null,
    laneId: null,
    modules: ["src/auth/guard.ts"],
    topics: [],
    symbols: [],
    trust: "high",
    confirmed: true,
    stale: false,
    status: "active",
    createdBy: "human:founder",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

// ADR-0026 §9: the panel must state which workspace it is showing, so the prop is
// REQUIRED and every render here supplies it.
const WORKSPACE = "/Users/dev/SWE/repo-a";

const expiredNote = note({
  id: "mem-expired",
  text: "The retry budget was probably three.",
  confirmed: false,
  trust: "low",
  createdBy: "agent:codex",
  expiresAt: "2026-06-01T00:00:00.000Z",
  expired: true,
});

describe("TUI MemoryPanel — R3 expiry", () => {
  it("advertises the non-verdict pause action", () => {
    const frame =
      render(
        <MemoryPanel
          title='"guard"'
          notes={[note()]}
          selectedIndex={0}
          workspacePath={WORKSPACE}
        />
      ).lastFrame() ?? "";
    expect(frame).toContain("p pause");
  });

  it("marks an expired row and advertises the toggle key", () => {
    const { lastFrame } = render(
      <MemoryPanel
        title='"guard"'
        notes={[note(), expiredNote]}
        selectedIndex={0}
        workspacePath={WORKSPACE}
        showExpired
      />
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("EXPIRED");
    expect(frame).toContain("The retry budget was probably three.");
    // Expiry hides, it never deletes — and confirming is the way back.
    expect(frame).toContain("hidden from recall, never deleted");
    expect(frame).toContain("including expired");
    expect(frame).toContain("e hide expired");
  });

  it("never marks a live row and offers the key when expired are hidden", () => {
    const { lastFrame } = render(
      <MemoryPanel title='"guard"' notes={[note()]} selectedIndex={0} workspacePath={WORKSPACE} />
    );
    const frame = lastFrame() ?? "";

    expect(frame).not.toContain("EXPIRED");
    expect(frame).not.toContain("including expired");
    expect(frame).toContain("e show expired");
  });

  it("keeps the empty state honest about what is being hidden", () => {
    const hidden = render(
      <MemoryPanel title='"guard"' notes={[]} selectedIndex={0} workspacePath={WORKSPACE} />
    );
    expect(hidden.lastFrame() ?? "").toContain(
      "No notes match — press e to include expired"
    );

    const shown = render(
      <MemoryPanel title='"guard"' notes={[]} selectedIndex={0} workspacePath={WORKSPACE} showExpired />
    );
    expect(shown.lastFrame() ?? "").toContain(
      "No notes match, including expired"
    );
  });
});

// ── P0-3 — the terminal's version of the founder's complaint ─────────────────
//
// The desktop card stopped rendering a Confirm affordance on settled crew
// memory. The TUI's equivalent affordances are the per-row "·review" marker and
// the keybar's "c confirm": both are the panel telling the operator a decision
// is owed, and neither may fire when MUON has already vouched for everything on
// screen.
describe("TUI MemoryPanel — settled crew memory asks for nothing", () => {
  const vouched = note({
    id: "mem-vouched",
    text: "The refund lane needs the idempotency key before it retries.",
    confirmed: false,
    confirmedBy: "orchestrator",
    trust: "medium",
    createdBy: "muon-capture",
  });

  const unvouched = note({
    id: "mem-open",
    text: "Nobody has vouched for this one.",
    confirmed: false,
    confirmedBy: null,
    trust: "low",
    createdBy: "muon-capture",
  });

  it("marks a vouched row settled, never as review debt, and offers c as a PROMOTION", () => {
    const { lastFrame } = render(
      <MemoryPanel title='"refund"' notes={[vouched]} selectedIndex={0} workspacePath={WORKSPACE} />
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("·muon");
    expect(frame).not.toContain("·review");
    // The keybar is the panel's only standing "do something" affordance.
    expect(frame).not.toContain("c confirm");
    expect(frame).toContain("c promote");
    // Rejecting a wrong memory stays available, exactly as on the desktop card.
    expect(frame).toContain("x reject");
    expect(frame).toContain("nothing is waiting on you");
  });

  it("DOES ask on an unvouched row — the marker and the confirm key are back", () => {
    const { lastFrame } = render(
      <MemoryPanel title='"refund"' notes={[unvouched]} selectedIndex={0} workspacePath={WORKSPACE} />
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("·review");
    expect(frame).toContain("c confirm");
    expect(frame).not.toContain("c promote");
    expect(frame).not.toContain("nothing is waiting on you");
  });

  it("tracks the SELECTED row: same list, different ask", () => {
    const both = [vouched, unvouched];
    expect(
      render(
        <MemoryPanel title='"refund"' notes={both} selectedIndex={0} workspacePath={WORKSPACE} />
      ).lastFrame() ?? ""
    ).toContain("c promote");
    expect(
      render(
        <MemoryPanel title='"refund"' notes={both} selectedIndex={1} workspacePath={WORKSPACE} />
      ).lastFrame() ?? ""
    ).toContain("c confirm");
    // One genuinely pending note is enough to drop the all-settled line.
    expect(
      render(
        <MemoryPanel title='"refund"' notes={both} selectedIndex={0} workspacePath={WORKSPACE} />
      ).lastFrame() ?? ""
    ).not.toContain("nothing is waiting on you");
  });

  it("hands a LAPSED vouch back to the human — nothing is vouching for it now", () => {
    const { lastFrame } = render(
      <MemoryPanel
        title='"refund"'
        notes={[{ ...vouched, expired: true }]}
        selectedIndex={0}
        workspacePath={WORKSPACE}
        showExpired
      />
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("EXPIRED");
    expect(frame).not.toContain("·muon");
    expect(frame).toContain("·review");
    expect(frame).toContain("c confirm");
  });
});

// ── ADR-0026 §9 — the panel states its PARTITION ─────────────────────────────
//
// "the panel currently renders no partition at all; it must state which workspace
// it is showing". The two `searchMemory` calls behind it (App.tsx:1178, :1663) sent
// no coordinate, so the same screen could show two repos' memory with nothing
// distinguishing them.
describe("TUI MemoryPanel — ADR-0026 workspace label", () => {
  it("renders the workspace it is showing", () => {
    const { lastFrame } = render(
      <MemoryPanel
        title='"guard"'
        notes={[note()]}
        selectedIndex={0}
        workspacePath={WORKSPACE}
      />
    );
    expect(lastFrame() ?? "").toContain(`workspace: ${WORKSPACE}`);
  });

  it("renders it on the EMPTY state too — an unlabelled empty answer is the leak", () => {
    // "nothing is remembered" and "nothing is remembered ABOUT THIS REPO" are
    // different facts, and only one of them is true.
    const { lastFrame } = render(
      <MemoryPanel
        title='"guard"'
        notes={[]}
        selectedIndex={0}
        workspacePath={WORKSPACE}
      />
    );
    expect(lastFrame() ?? "").toContain(`workspace: ${WORKSPACE}`);
  });
});
