import { describe, expect, it } from "vitest";
import { EVASION_CORPUS, residualDanger } from "@muon/protocol";
import { buildApprovalReview } from "../src/approval-review.js";
import type { ApprovalRequest } from "../src/types.js";

function approval(input: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    taskId: "task-1",
    requestedBy: "agent:muon-orchestrator",
    kind: "gate",
    reason: "Set fleet → claude-code=2, codex=1, cursor=0",
    status: "pending",
    gateTag: "[gate:set_fleet claude-code=2,codex=1,cursor=0]",
    ...input,
  };
}

describe("approval review projection", () => {
  it("derives the exact bound action, scope, and consequence", () => {
    const review = buildApprovalReview(approval());

    expect(review).toMatchObject({
      action: "Resize local agent fleet",
      scope: "Claude Code 2 · Codex 1 · Cursor 0",
      consequence:
        "MUON will add or remove local agent slots to match these exact counts.",
      binding: "[gate:set_fleet claude-code=2,codex=1,cursor=0]",
      approvable: true,
      degraded: false,
    });
  });

  it("disables approval when a stored route binding cannot be parsed", () => {
    const review = buildApprovalReview(
      approval({ gateTag: "[gate:unknown opaque]" })
    );

    expect(review.approvable).toBe(false);
    expect(review.degraded).toBe(true);
    expect(review.degradationReason).toMatch(/binding|reject/i);
  });

  it("disables approval when a command request has no structured evidence", () => {
    const review = buildApprovalReview(
      approval({
        kind: "command",
        gateTag: null,
        reason: "Run the focused test command",
      })
    );

    expect(review.action).toBe("Command request");
    expect(review.scope).toBe("Task task-1");
    expect(review.binding).toMatch(/no structured approval binding/i);
    expect(review.approvable).toBe(false);
    expect(review.degradationReason).toMatch(/structured evidence/i);
  });

  it("renders complete, digest-bound command evidence", () => {
    const review = buildApprovalReview(
      approval({
        kind: "command",
        gateTag: null,
        reason: "session tool 'Write' (session session-1)",
        evidence: {
          action: "Write",
          scope: "File: src/parser.ts",
          riskLevel: "medium",
          impactIfApproved: "Writes content to one file in the selected workspace.",
          payloadDigest: "a".repeat(64),
          details: {
            path: "src/parser.ts",
            bytes: "421",
            sessionId: "session-1",
          },
        },
      })
    );

    expect(review).toMatchObject({
      action: "Write",
      scope: "File: src/parser.ts",
      consequence: "Writes content to one file in the selected workspace.",
      risk: "medium",
      payloadDigest: "a".repeat(64),
      approvable: true,
      degraded: false,
    });
    expect(review.details).toEqual([
      { label: "Path", value: "src/parser.ts" },
      { label: "Bytes", value: "421" },
      { label: "Session ID", value: "session-1" },
    ]);
  });

  // ---- P0.4 slice 3: receipt eligibility (shows/hides the "remember" affordance;
  // the server mint 400 stays the final authority) ----

  function commandApproval(
    evidence: Partial<NonNullable<ApprovalRequest["evidence"]>> & {
      action: string;
    }
  ): ApprovalRequest {
    return approval({
      kind: "command",
      gateTag: null,
      reason: `session tool '${evidence.action}'`,
      evidence: {
        scope: "session session-1",
        riskLevel: "medium",
        impactIfApproved: "Bounded session tool call.",
        payloadDigest: "d".repeat(64),
        details: {},
        ...evidence,
      },
    });
  }

  it("marks digest-bound edit-class command evidence receipt-eligible", () => {
    const review = buildApprovalReview(
      commandApproval({ action: "Edit", details: { path: "src/parser.ts" } })
    );
    expect(review.receiptEligible).toBe(true);
  });

  it("marks digest-bound read-class command evidence receipt-eligible", () => {
    const review = buildApprovalReview(
      commandApproval({ action: "Read", details: { path: "src/parser.ts" } })
    );
    expect(review.receiptEligible).toBe(true);
  });

  it("shows the affordance for Bash and lets the server mint verdict rule", () => {
    // Without checkCommands the client cannot prove test-class, so Bash with a
    // command shows the affordance; an ineligible command 400s at mint.
    const review = buildApprovalReview(
      commandApproval({ action: "Bash", details: { command: "npm test" } })
    );
    expect(review.receiptEligible).toBe(true);
  });

  it("never marks network-class actions receipt-eligible", () => {
    const review = buildApprovalReview(
      commandApproval({
        action: "WebFetch",
        details: { url: "https://example.com" },
      })
    );
    expect(review.receiptEligible).toBe(false);
  });

  it("never marks unclassifiable or digest-less requests receipt-eligible", () => {
    // mcp tools are unclassifiable by construction.
    expect(
      buildApprovalReview(
        commandApproval({ action: "mcp__github__push", details: {} })
      ).receiptEligible
    ).toBe(false);
    // Edit without a payload digest cannot bind a receipt.
    expect(
      buildApprovalReview(
        commandApproval({
          action: "Edit",
          details: { path: "src/parser.ts" },
          payloadDigest: undefined,
        })
      ).receiptEligible
    ).toBe(false);
    // Edit without a target path is not provably edit-class.
    expect(
      buildApprovalReview(commandApproval({ action: "Edit", details: {} }))
        .receiptEligible
    ).toBe(false);
  });

  it("never marks gate kinds or degraded requests receipt-eligible", () => {
    expect(buildApprovalReview(approval()).receiptEligible).toBe(false);
    expect(
      buildApprovalReview(approval({ gateTag: "[gate:unknown opaque]" }))
        .receiptEligible
    ).toBe(false);
    expect(
      buildApprovalReview(
        approval({ kind: "command", gateTag: null, reason: "legacy" })
      ).receiptEligible
    ).toBe(false);
  });
});

// ── Round-3 #8: the evasion corpus, replayed at the approval projection ─────
//
// The reviewer's named "most dangerous omission": this is the one surface
// where untrusted text sits inside the trust frame of an UNBYPASSABLE human
// gate, and the one where the projection itself forgot a field rather than a
// caller forgetting to call it — `binding: approval.gateTag` went out raw
// while the docstring 60 lines above promised every agent-adjacent field
// passed through `terminalSafe` HERE.
describe("evasion corpus replay — the projection is the boundary", () => {
  const FIELDS = ["action", "scope", "consequence", "binding", "authority"] as const;

  it("no payload survives in ANY projected field, whichever branch builds it", () => {
    for (const payload of EVASION_CORPUS) {
      // Two branches: the structured-evidence one and the gateTag one. Both
      // reach a human gate, so both are replayed.
      const reviews = [
        buildApprovalReview({
          id: "a-1",
          taskId: "t-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: payload.text,
          status: "pending",
          evidence: {
            action: payload.text,
            scope: payload.text,
            riskLevel: "high",
            impactIfApproved: payload.text,
            details: {},
          },
        } as Parameters<typeof buildApprovalReview>[0]),
        buildApprovalReview({
          id: "a-2",
          taskId: "t-1",
          requestedBy: "claude-code",
          kind: "command",
          reason: "r",
          status: "pending",
          gateTag: payload.text,
        } as Parameters<typeof buildApprovalReview>[0]),
      ];
      for (const review of reviews) {
        for (const field of FIELDS) {
          const value = review[field];
          if (typeof value !== "string") continue;
          expect(
            residualDanger(value),
            `${payload.id} survived in ${field}`
          ).toEqual([]);
        }
      }
    }
  });

  it("the gateTag branch specifically — the field that shipped raw", () => {
    const repaint = EVASION_CORPUS.find(
      (payload) => payload.id === "ansi-clear-screen"
    )!;
    const review = buildApprovalReview({
      id: "a-3",
      taskId: "t-1",
      requestedBy: "claude-code",
      kind: "command",
      reason: "r",
      status: "pending",
      gateTag: repaint.text,
    } as Parameters<typeof buildApprovalReview>[0]);
    expect(review.binding).not.toContain(repaint.text);
    expect(residualDanger(review.binding)).toEqual([]);
  });
});
