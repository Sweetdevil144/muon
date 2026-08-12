import { describe, expect, it } from "vitest";
import { parseCostCapInput } from "../src/cost-cap.js";

/**
 * ONE rule, two surfaces. These are the inputs where a second, drifting
 * statement of "what counts as a cap" would have cost real money or real work.
 */
describe("parseCostCapInput", () => {
  it("REFUSES zero — it is not 'clear', it is a permanent refusal", () => {
    const parsed = parseCostCapInput("0");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    // A human who types 0 meaning "no limit" must not get the opposite.
    expect(parsed.message).toMatch(/Zero is refused/);
  });

  it("clears only on an explicit word", () => {
    for (const word of ["none", "clear", "off", "NONE", " none "]) {
      const parsed = parseCostCapInput(word);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.capUsd).toBeNull();
    }
  });

  it("takes a dollar sign and whitespace, and returns a number", () => {
    for (const raw of ["25", "$25", " $25.50 "]) {
      const parsed = parseCostCapInput(raw);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.capUsd).toBeGreaterThan(0);
    }
  });

  it("refuses negatives, junk, empties and infinities rather than coercing", () => {
    for (const raw of ["-5", "abc", "", "   ", "Infinity", "NaN"]) {
      expect(parseCostCapInput(raw).ok, raw).toBe(false);
    }
  });

  it("refuses a cap above the backend's own ceiling, beside the field", () => {
    const parsed = parseCostCapInput("2000000");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/refused/);
  });
});
