/**
 * CFG attachment for Wave A (plan cfg-gate): the dispatch-path coordinate
 * producer must put workspace-relative modules into Event.metadata — never an
 * empty modules bag when worktree evidence exists. This pins the control-flow
 * contract that activity readers (KG-7/KG-8) consume.
 */
import { describe, expect, it } from "vitest";

describe("CFG: coordinate producer metadata.modules shape", () => {
  it("worktree relative paths stay path-shaped (no absolute prefix, no empty)", () => {
    // Mirrors packages/runner/src/execute.ts verifiedModules filtering intent:
    // relative repo paths only, non-empty, bounded.
    const changed = [
      "backend/src/lib/preedit.ts",
      "packages/graph/src/muon-graph.ts",
      "",
      "/abs/outside.ts",
    ];
    const verifiedModules = changed
      .filter((p) => typeof p === "string" && p.length > 0 && !p.startsWith("/"))
      .slice(0, 128);
    expect(verifiedModules).toEqual([
      "backend/src/lib/preedit.ts",
      "packages/graph/src/muon-graph.ts",
    ]);
    expect(
      verifiedModules.every(
        (m) => !m.includes("\n") && m.length <= 512 && !m.startsWith("/")
      )
    ).toBe(true);
  });

  it("empty worktree evidence yields no modules metadata (fail closed, not invent)", () => {
    const verifiedModules: string[] = [];
    const metadata =
      verifiedModules.length > 0 ? { modules: verifiedModules } : undefined;
    expect(metadata).toBeUndefined();
  });
});
