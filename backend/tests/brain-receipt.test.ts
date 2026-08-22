import { describe, expect, it } from "vitest";
import { HANDOFF_DEGRADATION, type HandoffPacket } from "@muon/protocol";
import {
  applyBrainReceiptAudit,
  brainReceiptFindings,
} from "../src/lib/brain-receipt.js";

// ADR-0062 — the receipt audit's decision rules, every branch. The route
// test (dispatch-terminal-handoff) pins the wiring; this pins the verdicts.

function packet(overrides: Partial<HandoffPacket> = {}): HandoffPacket {
  return {
    taskGoal: "goal",
    whatChanged: "changed",
    whatFailed: "nothing",
    nextLaneRequest: "continue",
    commandsRun: [],
    checksStatus: [],
    openQuestions: [],
    provenance: { lane: "codex", createdAt: "2026-08-21T00:00:00.000Z" },
    schemaVersion: 2,
    changedFiles: [],
    diffVerified: false,
    checks: [],
    artifacts: [],
    uncertainties: [],
    unresolvedDecisions: [],
    memoryProposals: [],
    degraded: { flag: false, reasons: [] },
    ...overrides,
  };
}

describe("brainReceiptFindings", () => {
  it("no receipt → no_brain_receipt (silence is never either answer)", () => {
    expect(brainReceiptFindings(packet(), 0)).toEqual([
      HANDOFF_DEGRADATION.noBrainReceipt,
    ]);
  });

  it("claimed update with ZERO observed writes → mismatch", () => {
    expect(
      brainReceiptFindings(packet({ brainReceipt: "context_updated" }), 0)
    ).toEqual([
      `${HANDOFF_DEGRADATION.brainReceiptMismatch}:claimed_update_no_observed_writes`,
    ]);
  });

  it("claimed no-update while writes exist (either source) → mismatch", () => {
    expect(
      brainReceiptFindings(packet({ brainReceipt: "no_update_required" }), 2)
    ).toEqual([
      `${HANDOFF_DEGRADATION.brainReceiptMismatch}:observed_writes_exist`,
    ]);
    expect(
      brainReceiptFindings(
        packet({
          brainReceipt: "no_update_required",
          memoryProposals: [{ kind: "decision", text: "durable lesson" }],
        }),
        0
      )
    ).toEqual([
      `${HANDOFF_DEGRADATION.brainReceiptMismatch}:observed_writes_exist`,
    ]);
  });

  it("an UNREADABLE ledger never impersonates zero: accusations that need the observation are skipped, packet-evidence ones still fire", () => {
    // context_updated with no proposals: the only evidence would be the
    // ledger — unreadable, so no accusation.
    expect(
      brainReceiptFindings(
        packet({ brainReceipt: "context_updated" }),
        undefined
      )
    ).toEqual([]);
    // no_update_required with no proposals: same skip.
    expect(
      brainReceiptFindings(
        packet({ brainReceipt: "no_update_required" }),
        undefined
      )
    ).toEqual([]);
    // no_update_required with the packet's OWN proposals: evidence in hand,
    // the ledger is not needed.
    expect(
      brainReceiptFindings(
        packet({
          brainReceipt: "no_update_required",
          memoryProposals: [{ kind: "decision", text: "durable lesson" }],
        }),
        undefined
      )
    ).toEqual([
      `${HANDOFF_DEGRADATION.brainReceiptMismatch}:observed_writes_exist`,
    ]);
    // a missing receipt needs no observation to be missing.
    expect(brainReceiptFindings(packet(), undefined)).toEqual([
      HANDOFF_DEGRADATION.noBrainReceipt,
    ]);
  });

  it("agreement in both directions → nothing to report", () => {
    expect(
      brainReceiptFindings(packet({ brainReceipt: "no_update_required" }), 0)
    ).toEqual([]);
    expect(
      brainReceiptFindings(packet({ brainReceipt: "context_updated" }), 1)
    ).toEqual([]);
    expect(
      brainReceiptFindings(
        packet({
          brainReceipt: "context_updated",
          memoryProposals: [{ kind: "attempt", text: "tried the thing" }],
        }),
        0
      )
    ).toEqual([]);
  });
});

describe("applyBrainReceiptAudit", () => {
  it("appends to the packet's OWN degradation channel and flips the flag", () => {
    const audited = applyBrainReceiptAudit(
      packet({
        degraded: { flag: true, reasons: ["no_check_evidence"] },
      }),
      0
    );
    expect(audited.degraded.flag).toBe(true);
    expect(audited.degraded.reasons).toEqual([
      "no_check_evidence",
      HANDOFF_DEGRADATION.noBrainReceipt,
    ]);
  });

  it("an agreeing packet is returned untouched — same object, no rewrite", () => {
    const clean = packet({ brainReceipt: "no_update_required" });
    expect(applyBrainReceiptAudit(clean, 0)).toBe(clean);
  });

  it("respects the 20-reason bound AND the audit finding survives the eviction", () => {
    const full = packet({
      degraded: {
        flag: true,
        reasons: Array.from({ length: 20 }, (_, index) => `reason_${index}`),
      },
    });
    const audited = applyBrainReceiptAudit(full, 0);
    expect(audited.degraded.reasons).toHaveLength(20);
    // The server's own observation is the entry this route guarantees; the
    // builder's TAIL yields deterministically.
    expect(audited.degraded.reasons).toContain(
      HANDOFF_DEGRADATION.noBrainReceipt
    );
    expect(audited.degraded.reasons[0]).toBe("reason_0");
    expect(audited.degraded.reasons).not.toContain("reason_19");
  });
});
