import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  operatorSetting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));

vi.mock("../src/lib/db.js", () => ({ prisma: prismaMock }));

describe("memory compaction retention setting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the bounded default only when the setting is absent", async () => {
    prismaMock.operatorSetting.findUnique.mockResolvedValue(null);
    const { getMemoryCompactionRetentionDays } = await import(
      "../src/lib/operator-settings.js"
    );

    await expect(getMemoryCompactionRetentionDays()).resolves.toBe(30);
  });

  it("fails closed on malformed or unreadable destructive policy", async () => {
    const { getMemoryCompactionRetentionDays } = await import(
      "../src/lib/operator-settings.js"
    );

    for (const value of ["0", "3651", "1.5", "not-a-number"]) {
      prismaMock.operatorSetting.findUnique.mockResolvedValueOnce({
        key: "memoryCompactionRetentionDays",
        value,
      });
      await expect(getMemoryCompactionRetentionDays()).resolves.toBeNull();
    }

    prismaMock.operatorSetting.findUnique.mockRejectedValueOnce(
      new Error("store unavailable")
    );
    await expect(getMemoryCompactionRetentionDays()).resolves.toBeNull();
  });

  it("persists only integer retention windows from 1 through 3650 days", async () => {
    prismaMock.operatorSetting.upsert.mockResolvedValue({
      key: "memoryCompactionRetentionDays",
      value: "45",
    });
    const { setMemoryCompactionRetentionDays } = await import(
      "../src/lib/operator-settings.js"
    );

    await expect(setMemoryCompactionRetentionDays(45)).resolves.toBe(45);
    expect(prismaMock.operatorSetting.upsert).toHaveBeenCalledWith({
      where: { key: "memoryCompactionRetentionDays" },
      create: { key: "memoryCompactionRetentionDays", value: "45" },
      update: { value: "45" },
    });
    for (const invalid of [0, 3_651, 1.5, Number.NaN]) {
      await expect(
        setMemoryCompactionRetentionDays(invalid)
      ).rejects.toThrow("1-3650");
    }
  });
});
