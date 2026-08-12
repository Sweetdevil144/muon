import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// BUG 1: the desktop approval decision must ALWAYS land. When the operator opts
// to "remember" an action that can't be remembered, the server soft-skips the
// mint (200, not a red 400) and the main-process handler surfaces it as a gentle
// note — never as an error dialog. The handler is Electron-bound, so we assert
// its shape at the source level (same discipline as approval-entrypoints).
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

describe("muon:resolveApproval soft-skip surfacing", () => {
  const handler = source.slice(
    source.indexOf('"muon:resolveApproval"'),
    source.indexOf('"muon:applyWorkflowProposal"')
  );

  it("surfaces a skipped receipt softly (informational Notification), not an error", () => {
    // The handler reads the resolved decision and reacts to the soft signal.
    expect(handler).toContain("resolved.receiptSkipped");
    // A gentle, non-error surface — the same Notification affordance used for
    // other informational nudges, with reassuring "Approved" copy.
    expect(handler).toContain("new Notification");
    expect(handler).toContain("can't be remembered");
    // The decision still landed: it returns the soft signal, it does not throw
    // or leave the approval pending.
    expect(handler).toContain("receiptSkipped: true");
  });

  it("never treats the skip as a mint failure that drops the decision", () => {
    // No branch rejects/re-throws on a skip; the decision poll always runs.
    expect(handler).toContain("void monitor.poll()");
    expect(handler).not.toMatch(/throw .*receipt/i);
  });
});
