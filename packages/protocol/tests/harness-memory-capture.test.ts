import { describe, expect, it } from "vitest";
import { harnessConfigSchema } from "../src/harness.js";

describe("harness memoryCapture (TODO 4.19)", () => {
  it("defaults to mine and accepts reference", () => {
    const parsed = harnessConfigSchema.parse({});
    expect(parsed.memoryCapture).toBe("mine");
    expect(
      harnessConfigSchema.parse({ memoryCapture: "reference" }).memoryCapture
    ).toBe("reference");
  });
});
