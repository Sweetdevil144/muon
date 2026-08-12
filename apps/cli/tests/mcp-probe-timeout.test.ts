import { describe, expect, it } from "vitest";
import { parseProbeTimeout } from "../src/commands/mcp.js";

/**
 * The CLI's own half of `mcp probe`: the spawn and the comparison live in
 * @muon/client (the desk probes with them too), but `--timeout` is this
 * command's flag and its refusal is this command's promise.
 */
describe("--timeout is refused rather than silently defaulted", () => {
  it("takes a whole number of milliseconds", () => {
    expect(parseProbeTimeout(undefined)).toBe(20_000);
    expect(parseProbeTimeout("5000")).toBe(5_000);
  });

  it("refuses anything that would make the measurement unreproducible", () => {
    // Silently falling back to the default would mean the command waited a
    // different length than the operator asked for — and the one number this
    // command produces is a measurement.
    for (const bad of ["", "abc", "-1", "1.5", "500", "1e3s"]) {
      expect(() => parseProbeTimeout(bad), bad).toThrow(/--timeout/);
    }
  });
});
