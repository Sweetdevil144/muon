import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  prisma: {
    harness: {
      upsert: vi.fn(async () => ({})),
    },
  },
}));

vi.mock("../src/lib/db.js", () => dbMock);

import { ensureDefaultHarnesses } from "../src/lib/bootstrap.js";

describe("default harnesses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("seeds a bounded read-only planner harness for dispatch-spine planning", async () => {
    await ensureDefaultHarnesses();

    expect(dbMock.prisma.harness.upsert).toHaveBeenCalledWith({
      where: { key: "planner" },
      // Defaults re-sync on boot so seed changes reach existing installs.
      update: expect.objectContaining({ name: "Planner" }),
      create: expect.objectContaining({
        key: "planner",
        name: "Planner",
        createdBy: "muon",
        config: expect.objectContaining({
          profileOverlay: expect.objectContaining({
            permissionMode: "strict",
            sandbox: "read-only",
          }),
          budget: expect.objectContaining({
            maxWallMs: 120_000,
          }),
          requires: {
            interactive: false,
            worktree: false,
            // Feature #10: planner declares no required tools. Kept as an
            // EXACT shape rather than objectContaining, so the next field
            // added to `requires` also has to come through this assertion.
            tools: [],
          },
        }),
      }),
    });
  });
});
