import { describe, expect, it } from "vitest";
import {
  costOrdinalTier,
  formatCostOrdinalLabel,
} from "../src/renderer/lib/cost-ordinal-label.js";

describe("cost ordinal labels", () => {
  it("maps registry ordinals to low/mid/high tiers", () => {
    expect(costOrdinalTier(0.1)).toBe("low");
    expect(costOrdinalTier(0.4)).toBe("mid");
    expect(costOrdinalTier(0.9)).toBe("high");
  });

  it("never prints dollars — only ordinal + honest notice", () => {
    const label = formatCostOrdinalLabel(0.4);
    expect(label).toContain("cost · mid (0.4)");
    expect(label).toContain("cost accounting not yet metered");
    expect(label).not.toMatch(/\$/);
  });
});
