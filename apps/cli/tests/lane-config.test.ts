import { describe, expect, it } from "vitest";
import { parseProfileAssignments } from "../src/commands/lane.js";

describe("parseProfileAssignments", () => {
  it("parses plain string values", () => {
    expect(parseProfileAssignments(["model=opus-x"])).toEqual({
      model: "opus-x",
    });
  });

  it("parses JSON values (arrays, booleans, objects)", () => {
    expect(
      parseProfileAssignments(['extraArgs=["--max-turns","5"]', "sandbox=\"read-only\""])
    ).toEqual({
      extraArgs: ["--max-turns", "5"],
      sandbox: "read-only",
    });
  });

  it("supports dotted keys for rawConfig passthrough", () => {
    expect(
      parseProfileAssignments(["rawConfig.includeCoAuthoredBy=false"])
    ).toEqual({
      rawConfig: { includeCoAuthoredBy: false },
    });
  });

  it("rejects malformed pairs", () => {
    expect(() => parseProfileAssignments(["nonsense"])).toThrow(/key=value/);
  });
});
