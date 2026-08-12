import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { buildCapabilityPreflight } from "@muon/client";
import type { BrainSnapshot } from "../src/lib/brain-store.js";
import { emptyBrainSnapshot } from "../src/lib/brain-store.js";
import { preflightTone } from "../src/lib/theme.js";
import {
  DiagnosticsPanel,
  DispatchHero,
  ReviewInbox,
  buildDispatchSummary,
} from "../src/components/CockpitPanels.js";

const NOW = new Date("2026-07-16T12:00:00.000Z");

/** Codex BYOK + Cursor connected (readiness-only): status "ready". */
const readyPreflight = () =>
  buildCapabilityPreflight({
    brain: { reachable: true },
    readiness: {
      vendors: [
        {
          vendor: "codex",
          installed: true,
          authenticated: true,
          credentialMethod: "api-key",
          detail: "configured with a Codex API key",
          authState: "confirmed",
        },
        {
          vendor: "cursor",
          installed: true,
          authenticated: true,
          credentialMethod: "vendor-login",
          detail: "logged in as dev@example.com",
          authState: "confirmed",
        },
      ],
      generatedAt: "2026-07-16T11:59:58.000Z",
    },
    runner: {
      runner: { status: "online", lastSeenAt: "2026-07-16T11:59:59.000Z" },
      live: true,
    },
    now: NOW,
  });

/** Cursor needs setup (not yet authenticated): status "degraded". */
const degradedPreflight = () =>
  buildCapabilityPreflight({
    brain: { reachable: true },
    readiness: {
      vendors: [
        {
          vendor: "codex",
          installed: true,
          authenticated: true,
          credentialMethod: "api-key",
          detail: "configured with a Codex API key",
          authState: "confirmed",
        },
        {
          vendor: "cursor",
          installed: true,
          authenticated: false,
          detail: "IDE detected, not yet connected",
          fixHint: "Connect Cursor from Setup, then re-check.",
          authState: "negative",
        },
      ],
      generatedAt: "2026-07-16T11:59:58.000Z",
    },
    runner: {
      runner: { status: "online", lastSeenAt: "2026-07-16T11:59:59.000Z" },
      live: true,
    },
    now: NOW,
  });

/** Control plane unreachable (fetch failure): status "blocked". */
const blockedPreflight = () =>
  buildCapabilityPreflight({
    brain: { reachable: false, detail: "fetch failed" },
    readiness: null,
    runner: null,
    now: NOW,
  });

const snapshot: BrainSnapshot = {
  ...emptyBrainSnapshot(),
  health: {
    status: "ok",
    service: "muon-backend",
    timestamp: "2026-07-15T00:00:00.000Z",
  },
  readiness: [
    {
      vendor: "codex",
      installed: true,
      authenticated: true,
      credentialMethod: "api-key",
      detail: "provider ready",
    },
    {
      vendor: "cursor",
      installed: true,
      authenticated: false,
      detail: "IDE detected",
      fixHint: "readiness-only",
    },
  ],
  laneDoctor: { codex: "healthy", cursor: "degraded" },
  tasks: [
    {
      id: "task-1",
      title: "Ship cockpit",
      description: "",
      status: "in_progress",
      priority: "high",
    },
  ],
  events: [
    {
      id: "event-1",
      laneId: "lane-1",
      taskId: "task-1",
      kind: "task.progress",
      message: "changed auth",
      metadata: {
        modules: ["src/auth/guard.ts", "src/auth/session.ts"],
        symbols: ["src/auth/guard.ts#authorize"],
      },
      timestamp: "2026-07-15T00:00:00.000Z",
    },
  ],
  agents: [
    {
      id: "agent-1",
      vendor: "codex",
      name: "codex-1",
      ordinal: 1,
      status: "working",
      currentTaskId: "task-1",
    },
  ],
  approvals: [
    {
      id: "approval-1",
      taskId: "task-1",
      requestedBy: "codex",
      kind: "command",
      reason: "Apply changes",
      status: "pending",
    },
  ],
};

describe("TUI cockpit panels", () => {
  it("renders all four dispatch evidence channels at narrow width", () => {
    const { lastFrame } = render(
      <DispatchHero summary={buildDispatchSummary(snapshot, snapshot.tasks[0])} width={76} />
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("WHY THIS DISPATCH");
    expect(frame).toContain("MEMORY");
    expect(frame).toContain("CODE RADIUS");
    expect(frame).toContain("SYMBOL IMPACT");
    expect(frame).toContain("COORDINATES");
    expect(frame).toContain("src/auth/guard.ts");
  });

  it("makes the review inbox and panic action unmissable", () => {
    const { lastFrame } = render(
      <ReviewInbox
        approvals={snapshot.approvals}
        proposalCount={2}
        memoryReviewCount={1}
        width={42}
        focused
        selectedIndex={0}
      />
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("NEEDS YOUR DECISION");
    expect(frame).toContain("Apply changes");
    expect(frame).toContain("2 workflow proposals");
    expect(frame).toContain("1 memory review");
    expect(frame).toContain("a/r review selected");
  });

  it("keeps a one-token approval hint in compact profile instead of dropping it", () => {
    const { lastFrame } = render(
      <ReviewInbox
        approvals={snapshot.approvals}
        proposalCount={2}
        memoryReviewCount={1}
        width={42}
        focused
        selectedIndex={0}
        compact
      />
    );
    const frame = lastFrame() ?? "";

    expect(frame).toContain("NEEDS YOUR DECISION");
    expect(frame).toContain("a/r decide");
    expect(frame).not.toContain("a/r review selected");
  });

  describe("ReviewInbox active receipts (P0.4 parity)", () => {
    const NOW = new Date("2026-07-18T12:00:00.000Z");
    const receipt = (
      overrides: Partial<import("@muon/client").ApprovalReceipt> = {}
    ): import("@muon/client").ApprovalReceipt => ({
      id: "receipt-1",
      approvalId: "approval-1",
      taskId: "task-1",
      jobId: "job-1",
      workspacePath: "/repo",
      actionClass: "edit",
      toolName: "edit_file",
      payloadDigest: "digest",
      expiresAt: "2026-07-18T12:05:00.000Z",
      useCount: 0,
      ...overrides,
    });

    it("shows count + soonest expiry when active receipts exist for the current scope", () => {
      const { lastFrame } = render(
        <ReviewInbox
          approvals={snapshot.approvals}
          proposalCount={0}
          memoryReviewCount={0}
          width={42}
          activeReceipts={[
            receipt({ id: "r1", expiresAt: "2026-07-18T12:05:00.000Z" }),
            receipt({ id: "r2", expiresAt: "2026-07-18T13:00:00.000Z" }),
          ]}
          now={NOW}
        />
      );
      const frame = lastFrame() ?? "";

      expect(frame).toContain("2 receipts active");
      expect(frame).toContain("soonest expiry in 5m");
    });

    it("renders nothing when there are no active receipts (successfully polled, empty)", () => {
      const { lastFrame } = render(
        <ReviewInbox
          approvals={snapshot.approvals}
          proposalCount={0}
          memoryReviewCount={0}
          width={42}
          activeReceipts={[]}
          now={NOW}
        />
      );
      const frame = lastFrame() ?? "";

      expect(frame).not.toContain("receipt");
    });

    it("renders nothing on a receipts poll failure — honest absence, never a stale count", () => {
      const { lastFrame } = render(
        <ReviewInbox
          approvals={snapshot.approvals}
          proposalCount={0}
          memoryReviewCount={0}
          width={42}
          activeReceipts={null}
          now={NOW}
        />
      );
      const frame = lastFrame() ?? "";

      expect(frame).not.toContain("receipt");
    });

    it("compact profile renders a summary-only receipts count, no soonest-expiry detail", () => {
      const { lastFrame } = render(
        <ReviewInbox
          approvals={snapshot.approvals}
          proposalCount={0}
          memoryReviewCount={0}
          width={42}
          activeReceipts={[receipt()]}
          now={NOW}
          compact
        />
      );
      const frame = lastFrame() ?? "";

      expect(frame).toContain("1 receipt active");
      expect(frame).not.toContain("soonest expiry");
    });

    it("never offers a mint/revoke affordance — the TUI is read-only for receipts", () => {
      const { lastFrame } = render(
        <ReviewInbox
          approvals={snapshot.approvals}
          proposalCount={0}
          memoryReviewCount={0}
          width={42}
          activeReceipts={[receipt()]}
          now={NOW}
        />
      );
      const frame = (lastFrame() ?? "").toLowerCase();

      expect(frame).not.toContain("revoke");
      expect(frame).not.toContain("mint");
    });
  });

  describe("DiagnosticsPanel (P0.5 capability preflight)", () => {
    it("renders the ready headline, BYOK vendor, and the stop-all shortcut", () => {
      const snap: BrainSnapshot = { ...snapshot, preflight: readyPreflight() };
      const { lastFrame } = render(<DiagnosticsPanel snapshot={snap} width={76} />);
      const frame = lastFrame() ?? "";

      expect(frame).toContain("DOCTOR");
      expect(frame).toContain(readyPreflight().headline);
      expect(frame).toContain("Codex");
      expect(frame).toContain("BYOK");
      expect(frame).toContain("Cursor");
      expect(frame).toContain("! Stop all");
      // BYOK invariant: a usable account never reads as missing/signed out.
      expect(frame).not.toMatch(/missing|sign[ -]?ed?\s?out|log[ -]?ged?\s?out/i);
    });

    it("degraded preflight renders the degradation as code · reason — nextAction", () => {
      const preflight = degradedPreflight();
      expect(preflight.status).toBe("degraded");
      const snap: BrainSnapshot = { ...snapshot, preflight };
      const { lastFrame } = render(<DiagnosticsPanel snapshot={snap} width={160} />);
      const frame = lastFrame() ?? "";

      const degradation = preflight.degradations.find(
        (d) => d.code === "VENDOR_SETUP_NEEDED"
      );
      expect(degradation).toBeDefined();
      expect(frame).toContain("DOCTOR");
      expect(frame).toContain(preflight.headline);
      expect(frame).toContain(degradation!.code);
      expect(frame).toContain(degradation!.nextAction);
    });

    it("blocked (control-plane unreachable) preflight renders the blocked-tone headline, never ready", () => {
      // Pin down the tone mapping directly: chalk emits no ANSI in this
      // non-TTY test runner, so color can't be asserted from the frame text.
      expect(preflightTone("blocked")).toBe("red");
      expect(preflightTone("degraded")).not.toBe("red");
      expect(preflightTone("ready")).not.toBe("red");

      const preflight = blockedPreflight();
      const snap: BrainSnapshot = { ...snapshot, preflight };
      const { lastFrame } = render(<DiagnosticsPanel snapshot={snap} width={160} />);
      const frame = lastFrame() ?? "";

      expect(frame).toContain(preflight.headline); // "Control offline"
      expect(frame).not.toMatch(/\bReady\b/);
    });

    it("fetch failure degrades honestly to the contract's unreachable state, never a crash", () => {
      const preflight = blockedPreflight();
      expect(preflight.status).toBe("blocked");
      expect(preflight.brainHealth.state).toBe("unreachable");
      expect(preflight.runnerHealth.state).toBe("unknown");
      expect(preflight.degradations.map((d) => d.code)).toEqual([
        "CONTROL_PLANE_UNREACHABLE",
      ]);

      const snap: BrainSnapshot = { ...snapshot, preflight };
      const { lastFrame } = render(<DiagnosticsPanel snapshot={snap} width={160} />);
      const frame = lastFrame() ?? "";

      expect(frame).toContain("CONTROL_PLANE_UNREACHABLE");
      expect(frame).toContain("Restart MUON");
      expect(frame).not.toContain("undefined");
      expect(frame).not.toContain("NaN");
    });

    it("preflight not yet fetched renders an honest loading state, never a guessed ready", () => {
      const snap: BrainSnapshot = { ...snapshot, preflight: null };
      const { lastFrame } = render(<DiagnosticsPanel snapshot={snap} width={76} />);
      const frame = lastFrame() ?? "";

      expect(frame).toContain("DOCTOR");
      expect(frame).toContain("checking");
      expect(frame).not.toMatch(/\bReady\b/);
      expect(frame).toContain("! Stop all");
    });

    it("compact profile renders a count-only summary, no code/reason/nextAction lines", () => {
      const preflight = degradedPreflight();
      const snap: BrainSnapshot = { ...snapshot, preflight };
      const { lastFrame } = render(
        <DiagnosticsPanel snapshot={snap} width={76} compact />
      );
      const frame = lastFrame() ?? "";

      const degradation = preflight.degradations.find(
        (d) => d.code === "VENDOR_SETUP_NEEDED"
      );
      expect(frame).toContain("DOCTOR");
      expect(frame).toMatch(/1 needs? attention/);
      expect(frame).not.toContain("VENDOR_SETUP_NEEDED");
      expect(frame).not.toContain(degradation!.reason);
      expect(frame).not.toContain(degradation!.nextAction);
    });

    it("compact profile with nothing to fix shows a plain ready count, not the degradation strip", () => {
      const preflight = readyPreflight();
      const snap: BrainSnapshot = { ...snapshot, preflight };
      const { lastFrame } = render(
        <DiagnosticsPanel snapshot={snap} width={76} compact />
      );
      const frame = lastFrame() ?? "";

      expect(frame).toContain("DOCTOR");
      expect(frame).toMatch(/crew ready/);
      expect(frame).not.toContain("CURSOR_TAKEOVER_ONLY");
    });
  });
});
