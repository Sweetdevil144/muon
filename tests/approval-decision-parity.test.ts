/**
 * Every surface that resolves an approval must build its payload with
 * `buildApprovalDecision`.
 *
 * A governed write must not have a per-surface dialect. `decisionNotes` is
 * consumed by the audit event, `muon report` and the exported bundle, so a
 * surface that assembles the payload by hand can silently drop the attribution
 * — which is what had happened to three of them:
 *
 *   - the CLI sent `decisionNotes: options.notes`, i.e. `undefined` whenever
 *     no --notes was passed, so a human's CLI approval reached the ledger
 *     looking exactly like a scripted API call;
 *   - a TUI action path did the same with `notes?.trim() || undefined`;
 *   - the desktop approvals monitor hand-copied the literal "decided from MUON
 *     desktop", so a supplied note REPLACED the attribution rather than
 *     carrying it — losing it precisely on Full Auto's auto-approvals.
 *
 * This scans source rather than behaviour on purpose: the bug is not that any
 * one payload is wrong today, it is that a NEW call site can be added by hand
 * and no behavioural test would notice until an audit needed the field.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();

/** Files that call `client.resolveApproval(` outside tests and the client itself. */
function callSites(): string[] {
  const out = execFileSync(
    "bash",
    [
      "-c",
      `grep -rln 'resolveApproval(' --include='*.ts' --include='*.tsx' ` +
        `--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=staged ` +
        `--exclude-dir=release apps packages/client/src 2>/dev/null || true`,
    ],
    { cwd: ROOT, encoding: "utf8" }
  );
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => !/\.test\.|\/tests?\//.test(f))
    // Declaration files describe the API; they call nothing.
    .filter((f) => !f.endsWith(".d.ts"))
    // The client DEFINES resolveApproval; the builder is its input, not its caller.
    .filter((f) => !f.endsWith("packages/client/src/api-client.ts"))
    .filter((f) => !f.endsWith("packages/client/src/approval-decision.ts"))
    // Type-only declarations of the bridge//cleanup shims call nothing.
    .filter((f) => !f.endsWith("apps/desktop/src/shared/ipc.ts"))
    .filter((f) => !f.endsWith("packages/client/src/quickstart-cleanup.ts"))
    .filter((f) => !f.endsWith("packages/client/src/approval-review.ts"));
}

describe("approval decisions are built in exactly one place", () => {
  const files = callSites();

  it("finds the real call sites (guard against the scan silently matching nothing)", () => {
    // If this ever drops to zero the rest of the suite would pass vacuously.
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  for (const file of files) {
    it(`${file} routes through buildApprovalDecision`, () => {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      // The renderer reaches the API through the preload bridge, which lands in
      // desktop main — main is the one that must build the payload.
      if (file.endsWith("apps/desktop/src/renderer/app.tsx")) {
        expect(src).toContain("window.muon.resolveApproval");
        return;
      }
      expect(
        src.includes("buildApprovalDecision"),
        `${file} calls resolveApproval without buildApprovalDecision`
      ).toBe(true);
    });
  }

  it("no surface hand-writes an attribution sentence", () => {
    // The sentence belongs to the builder. A hand-written copy is how the
    // desktop monitor's note came to REPLACE the attribution, and how the TUI
    // ended up passing "decided from MUON TUI" as a human note and rendering
    // "decided from MUON TUI (decided from MUON TUI)".
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      for (const line of src.split("\n")) {
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
        if (/["'`]decided from MUON|["'`]manually reviewed from MUON/.test(line)) {
          offenders.push(`${file}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
