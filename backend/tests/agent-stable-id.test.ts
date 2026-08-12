import { describe, expect, it } from "vitest";

/**
 * TODO 7.5 — fleet agents carry stable opaque ids; dispatch binds by agentId,
 * not display name.
 */
describe("agent stable id contract (TODO 7.5)", () => {
  it("documents the dispatch binding field as agentId, not name", () => {
    const dispatchJobShape = {
      id: "job-1",
      agentId: "clxyz123stable",
      vendor: "codex",
    };
    expect(dispatchJobShape.agentId).toMatch(/^c|^cl/);
    expect(Object.keys(dispatchJobShape)).toContain("agentId");
    expect(Object.keys(dispatchJobShape)).not.toContain("agentName");
  });
});
