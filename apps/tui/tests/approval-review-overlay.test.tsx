import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { plainFrame } from "./ansi.js";
import { evasionPayloads, residualDanger } from "@muon/client";
import { ApprovalReviewOverlay } from "../src/components/ApprovalReviewOverlay.js";

describe("ApprovalReviewOverlay", () => {
  it("shows complete structured evidence and the three-action shortcuts", () => {
    const { lastFrame } = render(
      <ApprovalReviewOverlay
        width={100}
        approval={{
          id: "approval-1",
          taskId: "task-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: "session tool request",
          status: "pending",
          evidence: {
            action: "Write",
            scope: "session session-1 · /repo/src/auth.ts",
            riskLevel: "high",
            impactIfApproved: "Writes the requested authentication module.",
            payloadDigest: "a".repeat(64),
            details: {
              tool: "Write",
              target: "/repo/src/auth.ts",
            },
          },
        }}
      />
    );
    const frame = plainFrame(lastFrame() ?? "");

    expect(frame).toContain("NEEDS YOUR APPROVAL · HIGH");
    expect(frame).toContain("Scope: session session-1");
    expect(frame).toContain(
      "Consequence: Writes the requested authentication module."
    );
    expect(frame).toContain("payload SHA-256");
    expect(frame).toContain("Tool: Write");
    // A bare Write with no classifiable path can't be remembered, so the row is
    // approve + reject — and the frame says why, never leaving it a mystery.
    expect(frame).toContain("a approve · r reject · Esc close");
    expect(frame).toContain("This one always asks");
  });

  it("offers 'don't ask again' only for receipt-eligible actions, and says the scope either way", () => {
    const eligible = render(
      <ApprovalReviewOverlay
        width={100}
        approval={{
          id: "approval-edit",
          taskId: "task-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: "session tool request",
          status: "pending",
          evidence: {
            action: "Edit",
            scope: "session session-1 · /repo/src/auth.ts",
            riskLevel: "medium",
            impactIfApproved: "Edits the selected file.",
            payloadDigest: "b".repeat(64),
            details: { path: "/repo/src/auth.ts" },
          },
        }}
      />
    );
    const eligibleFrame = plainFrame(eligible.lastFrame() ?? "");
    expect(eligibleFrame).toContain("A approve, don't ask again");
    // The one honest sentence — byte-identical to the desktop button's title.
    expect(eligibleFrame).toContain(
      "Auto-approves this exact action, in this run, for the next 15"
    );

    const network = render(
      <ApprovalReviewOverlay
        width={100}
        approval={{
          id: "approval-network",
          taskId: "task-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: "session tool request",
          status: "pending",
          evidence: {
            action: "WebFetch",
            scope: "https://example.com",
            riskLevel: "high",
            impactIfApproved: "Fetches a remote URL.",
            payloadDigest: "b".repeat(64),
            details: { url: "https://example.com" },
          },
        }}
      />
    );
    const networkFrame = plainFrame(network.lastFrame() ?? "");
    expect(networkFrame).not.toContain("A approve, don't ask again");
    expect(networkFrame).toContain("a approve · r reject");
    expect(networkFrame).toContain("This one always asks");
  });

  it("fails closed when command evidence is missing", () => {
    const { lastFrame } = render(
      <ApprovalReviewOverlay
        width={100}
        approval={{
          id: "approval-legacy",
          taskId: "task-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: "legacy request",
          status: "pending",
        }}
      />
    );
    const frame = plainFrame(lastFrame() ?? "");

    expect(frame).toContain("Cannot approve:");
    expect(frame).not.toContain("a approve ·");
    expect(frame).toContain("r reject malformed request");
  });

  it("shows blind merge files and the explicit manual-review shortcut", () => {
    const { lastFrame } = render(
      <ApprovalReviewOverlay
        width={100}
        approval={{
          id: "approval-merge",
          taskId: "task-1",
          requestedBy: "codex",
          kind: "merge",
          reason: "ship review passed",
          status: "pending",
        }}
        certification={{
          status: "blocked",
          blockCode: "review-blind",
          reason: "REVIEW BLIND: one new file is absent from the index.",
          changedFiles: ["src/new.ts"],
          blindFiles: ["src/new.ts"],
          artifactDigest: "d".repeat(64),
        }}
      />
    );
    const frame = plainFrame(lastFrame() ?? "");

    expect(frame).toContain("src/new.ts");
    expect(frame).toContain("press m");
    expect(frame).toContain("m attest reviewed blind files + approve");
    expect(frame).not.toContain("a approve ·");
  });

  it("keeps stale graph evidence non-bypassable", () => {
    const { lastFrame } = render(
      <ApprovalReviewOverlay
        width={100}
        approval={{
          id: "approval-merge-stale",
          taskId: "task-1",
          requestedBy: "codex",
          kind: "merge",
          reason: "ship review passed",
          status: "pending",
        }}
        certification={{
          status: "blocked",
          blockCode: "stale",
          reason: "GitNexus review evidence is stale.",
          changedFiles: ["src/a.ts"],
          artifactDigest: "e".repeat(64),
        }}
      />
    );
    const frame = plainFrame(lastFrame() ?? "");

    expect(frame).toContain("Cannot approve: GitNexus review evidence is stale.");
    expect(frame).toContain("r reject · Esc close");
    expect(frame).not.toContain("press m");
  });
});

// ── Round-3 #8: the corpus at the RENDER boundary ───────────────────────────
//
// The projection sanitizes (packages/client/approval-review.ts), but this
// component also renders fields the projection never sees. TWO of them carry
// content MUON did not author — `certificationError` and
// `certification.reason`, both built by interpolating a caught error — and
// each is mutation-checked below: dropping `terminalSafe` from either fails
// this suite.
//
// `degradationReason` is deliberately NOT claimed: every value it can take is
// a fixed MUON-authored sentence (`approval-review.ts:156,174`), so the
// corpus cannot reach it and a fixture pretending otherwise would be exactly
// the false coverage this replay exists to prevent. Its `terminalSafe` call
// stays as defence-in-depth on a constant.
describe("evasion corpus replay — nothing hostile reaches the frame", () => {
  /**
   * THREE render sites, three fixtures — the first version of this replay
   * set `certificationError` unconditionally, which short-circuits the
   * certification ladder, and used an approval shape whose
   * `degradationReason` is always null. Two of the three sites it claimed to
   * cover never rendered, so dropping `terminalSafe` from either left it
   * green. Each site now gets a fixture that actually reaches it.
   */
  function frames(text: string): string[] {
    const merge = {
      id: "approval-1",
      taskId: "task-1",
      requestedBy: "claude-code",
      kind: "merge",
      reason: text,
      status: "pending",
    } as Parameters<typeof ApprovalReviewOverlay>[0]["approval"];

    const certificationError = render(
      <ApprovalReviewOverlay width={100} approval={merge} certificationError={text} />
    );
    // No certificationError ⇒ the ladder runs and `certification.reason`
    // renders on the blocked branch.
    const blockedCertification = render(
      <ApprovalReviewOverlay
        width={100}
        approval={merge}
        certification={{
          status: "blocked",
          blockCode: "unavailable",
          reason: text,
          artifactDigest: "b".repeat(64),
          changedFiles: [],
        }}
      />
    );
    // A `command` approval WITHOUT structured evidence is the degraded
    // shape, which is the only one that renders `degradationReason`.
    const degraded = render(
      <ApprovalReviewOverlay
        width={100}
        approval={{
          id: "approval-2",
          taskId: "task-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: text,
          status: "pending",
        } as Parameters<typeof ApprovalReviewOverlay>[0]["approval"]}
      />
    );
    return [
      certificationError.lastFrame() ?? "",
      blockedCertification.lastFrame() ?? "",
      degraded.lastFrame() ?? "",
    ];
  }

  function frameFor(text: string): string {
    return frames(text).join("\n");
  }

  it("no CONTROL-carrying payload survives into the rendered frame", () => {
    for (const payload of evasionPayloads(
      "invisible-directive",
      "reorder",
      "repaint",
      "row-forgery"
    )) {
      const raw = frameFor(payload.text);
      // plainFrame strips Ink's OWN SGR styling; the frame is a multi-line
      // box so its newlines are Ink's too. Anything dangerous left after
      // subtracting both came from the payload.
      expect(
        residualDanger(plainFrame(raw), ["\n"]),
        `${payload.id} left hostile bytes in the frame`
      ).toEqual([]);
      expect(raw, `${payload.id} rendered verbatim`).not.toContain(payload.text);
    }
  }, 30_000);

  it("a CONFUSABLE renders unchanged — and that is correct, not a gap", () => {
    // The limit of this control, pinned so nobody "fixes" it later: the
    // sanitizer strips control and format characters. A homoglyph carries
    // NONE — "МUОN" is ordinary letters that merely look Latin — so it
    // passes through, exactly as any legitimate non-Latin string must.
    // Defending against confusables is a different control (a confusable
    // fold at the comparison site), and pretending this one covers it would
    // be the same kind of false absolute the docstrings just lost.
    for (const payload of evasionPayloads("homoglyph", "normalization")) {
      const raw = frameFor(payload.text);
      expect(residualDanger(plainFrame(raw), ["\n"])).toEqual([]);
      expect(plainFrame(raw)).toContain(payload.text);
    }
    // Explicit budget: this replays the corpus through real Ink renders
    // (three fixtures per payload), which is legitimately slow under a
    // loaded parallel suite — it passed alone and failed only in the full
    // run, which is a scheduling fact, not a behaviour change.
  }, 30_000);
});
