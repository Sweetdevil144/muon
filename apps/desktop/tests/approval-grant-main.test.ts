import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ADR-0056, the main-process half. The handler is Electron-bound and cannot be
// imported, so its properties are asserted at the source level — the same
// discipline `resolve-approval-soft-skip.test.ts` and `approval-entrypoints`
// already use for this file. NODE environment on purpose: the renderer half
// lives in approval-grant-desktop.test.tsx, where `import.meta.url` is not a
// file URL and a source read is impossible.

describe("ADR-0056 — the main-process half of the decision", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const handler = source.slice(
    source.indexOf('"muon:resolveApproval"'),
    source.indexOf('"muon:shipTask"')
  );

  it("carries the grade to the brain through the ONE shared decision builder", () => {
    expect(handler).toContain("grantDuration?: ApprovalGrantDuration");
    expect(handler).toContain("buildApprovalDecision");
    expect(handler).toContain('surface: "MUON desktop"');
    // Never a hand-built `grant: { duration }` next to the builder — one
    // dialect, or the attribution/grade drifts the way `decisionNotes` did.
    expect(handler).not.toMatch(/grant:\s*\{\s*duration/);
  });

  it("refuses a receipt and a grade on one decision, in the operator's words", () => {
    expect(handler).toMatch(
      /input\.receiptTtlMs !== undefined &&\s*input\.grantDuration !== undefined/
    );
    expect(handler).toContain("one durable authority");
    // A rejection cannot be remembered, and a merge attestation is never a
    // grant — both refused here, not silently dropped by the server.
    expect(handler).toContain("A rejection cannot be remembered.");
    expect(handler).toContain(
      "Merge review and durable approval grants cannot be combined."
    );
  });

  it("says out loud what a minted grant covers — ADR-0056 D8", () => {
    // "A grant that resolves something invisibly is the failure mode": the
    // mint names the tool, the target, the chat scope, the expiry and revocation.
    expect(handler).toContain("resolved.grant");
    expect(handler).toContain("remembered for this chat");
    expect(handler).toContain("will not ask again in this chat until");
    // The kill switch is NAMED, and it names the surface that actually has one
    // — the desktop does not list grants yet, and copy that points at a screen
    // which cannot do the thing is worse than no copy.
    expect(handler).toContain("muon policy revoke --grant-id");
  });
});
