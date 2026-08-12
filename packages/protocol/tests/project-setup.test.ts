import { describe, expect, it } from "vitest";
import {
  projectSetupConfirmationMatches,
  projectSetupContentHash,
  projectSetupConfirmationRequest,
  projectSetupPlanContentHash,
  resolveProjectSetupPlan,
} from "../src/project-setup.js";

describe("resolveProjectSetupPlan", () => {
  it("merges project and local layers, then applies worktree and user priority", () => {
    const plan = resolveProjectSetupPlan({
      project: {
        setup: [{ command: "npm", args: ["ci"] }],
        teardown: [{ command: "npm", args: ["run", "clean"] }],
      },
      local: {
        setup: [{ command: "npm", args: ["run", "build"] }],
      },
      worktree: {
        setup: [{ command: "echo", args: ["worktree"] }],
      },
      user: {
        setup: [{ command: "echo", args: ["user"] }],
      },
    });

    expect(plan.setup).toEqual([{ command: "echo", args: ["user"] }]);
    expect(plan.teardown).toEqual([{ command: "npm", args: ["run", "clean"] }]);
    expect(plan.sources.setup).toBe("user");
    expect(plan.sources.teardown).toBe("project");
    expect(plan.repoCommittedSetup).toEqual([{ command: "npm", args: ["ci"] }]);
    expect(plan.confirmationBound.setup).toEqual([]);
    expect(plan.confirmationBound.teardown).toEqual([
      { command: "npm", args: ["run", "clean"] },
    ]);
  });

  it("uses local-merge when worktree and user omit setup", () => {
    const plan = resolveProjectSetupPlan({
      project: { setup: [{ command: "npm", args: ["ci"] }] },
      local: { setup: [{ command: "npm", args: ["run", "build"] }] },
    });

    expect(plan.setup).toEqual([
      { command: "npm", args: ["ci"] },
      { command: "npm", args: ["run", "build"] },
    ]);
    expect(plan.sources.setup).toBe("local");
    expect(plan.confirmationBound.setup).toEqual(plan.setup);
  });

  it("lets worktree override merged project setup", () => {
    const plan = resolveProjectSetupPlan({
      project: { setup: [{ command: "npm", args: ["ci"] }] },
      local: { setup: [{ command: "npm", args: ["run", "build"] }] },
      worktree: { setup: [{ command: "make" }] },
    });

    expect(plan.setup).toEqual([{ command: "make" }]);
    expect(plan.sources.setup).toBe("worktree");
    expect(plan.confirmationBound.setup).toEqual([{ command: "make" }]);
  });
});

describe("projectSetupPlanContentHash", () => {
  it("binds setup, teardown, and run fields independently", () => {
    const base = {
      setup: [{ command: "npm", args: ["ci"] }],
      teardown: [] as Array<{ command: string; args?: string[] }>,
      run: [] as Array<{ command: string; args?: string[] }>,
    };
    expect(projectSetupPlanContentHash(base)).not.toBe(
      projectSetupPlanContentHash({
        ...base,
        teardown: [{ command: "npm", args: ["run", "clean"] }],
      })
    );
  });
});

describe("projectSetupContentHash", () => {
  it("changes when repo-committed setup changes", () => {
    const first = projectSetupContentHash([{ command: "npm", args: ["ci"] }]);
    const second = projectSetupContentHash([{ command: "npm", args: ["install"] }]);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("projectSetupConfirmationMatches", () => {
  it("requires confirmation for non-empty repo setup", () => {
    const repoSetup = [{ command: "npm", args: ["ci"] }];
    const hash = projectSetupContentHash(repoSetup);
    expect(
      projectSetupConfirmationMatches({ repoCommittedSetup: repoSetup })
    ).toBe(false);
    expect(
      projectSetupConfirmationMatches({
        repoCommittedSetup: repoSetup,
        record: { version: 1, setupHash: hash, confirmedAt: new Date().toISOString() },
      })
    ).toBe(true);
    expect(
      projectSetupConfirmationMatches({
        repoCommittedSetup: repoSetup,
        record: {
          version: 1,
          setupHash: "stale",
          confirmedAt: new Date().toISOString(),
        },
      })
    ).toBe(false);
  });

  it("skips confirmation when repo setup is empty", () => {
    expect(projectSetupConfirmationMatches({ repoCommittedSetup: [] })).toBe(true);
  });

  it("matches only the complete confirmation-bound lifecycle plan", () => {
    const confirmationBound = {
      setup: [{ command: "npm", args: ["ci"] }],
      teardown: [{ command: "npm", args: ["run", "clean"] }],
      run: [] as Array<{ command: string; args?: string[] }>,
    };
    expect(projectSetupConfirmationMatches({ confirmationBound })).toBe(false);
    expect(
      projectSetupConfirmationMatches({
        confirmationBound,
        record: {
          version: 1,
          setupHash: projectSetupPlanContentHash(confirmationBound),
          confirmedAt: new Date().toISOString(),
        },
      })
    ).toBe(true);
  });
});

describe("projectSetupConfirmationRequest", () => {
  it("returns undefined when there is no repo-committed setup", () => {
    const plan = resolveProjectSetupPlan({
      user: { setup: [{ command: "echo", args: ["hi"] }] },
    });
    expect(projectSetupConfirmationRequest(plan)).toBeUndefined();
  });

  it("binds confirmation to every effective non-user lifecycle command", () => {
    const plan = resolveProjectSetupPlan({
      project: {
        setup: [{ command: "npm", args: ["ci"] }],
        teardown: [{ command: "npm", args: ["run", "clean"] }],
        run: [{ command: "npm", args: ["start"] }],
      },
      local: { setup: [{ command: "npm", args: ["run", "build"] }] },
    });
    const request = projectSetupConfirmationRequest(plan);
    expect(request?.repoSetup).toEqual(plan.setup);
    expect(request?.effectiveSetup).toHaveLength(2);
    expect(request?.confirmationBound).toEqual(plan.confirmationBound);
    expect(request?.effective).toEqual({
      setup: plan.setup,
      teardown: plan.teardown,
      run: plan.run,
    });
    expect(request?.setupHash).toBe(
      projectSetupPlanContentHash(plan.confirmationBound)
    );
  });

  it("requires confirmation for a worktree override even without project setup", () => {
    const plan = resolveProjectSetupPlan({
      worktree: { setup: [{ command: "touch", args: ["repo-controlled"] }] },
    });
    expect(projectSetupConfirmationRequest(plan)?.confirmationBound.setup).toEqual(
      plan.setup
    );
  });
});
