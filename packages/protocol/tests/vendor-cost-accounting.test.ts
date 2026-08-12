import { describe, expect, it } from "vitest";
import {
  COST_ACCOUNTING_NOT_METERED,
  CREW_COST_ACCOUNTING,
  VENDOR_REGISTRY,
  isVendorId,
  vendorCostOrdinalView,
} from "../src/vendor.js";

describe("vendorCostOrdinalView — TODO 5.3 placeholder", () => {
  it("never invents dollars — only the registry ordinal and an honest notice", () => {
    for (const vendor of Object.keys(VENDOR_REGISTRY)) {
      if (!isVendorId(vendor)) continue;
      const view = vendorCostOrdinalView(vendor);
      expect(view.metered).toBe(false);
      expect(view.notice).toBe(COST_ACCOUNTING_NOT_METERED);
      expect(view.ordinal).toBe(VENDOR_REGISTRY[vendor].cost);
      expect(Object.keys(view).sort()).toEqual(
        ["metered", "notice", "ordinal"].sort()
      );
    }
  });

  it("shares one crew-level placeholder object", () => {
    expect(CREW_COST_ACCOUNTING).toEqual({
      metered: false,
      notice: COST_ACCOUNTING_NOT_METERED,
    });
  });
});
