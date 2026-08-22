import { describe, expect, it } from "vitest";
import {
  marketingEventForClick,
  marketingEventForPath,
} from "./marketing-events";

/**
 * The 2026-08-23 appendix B1 events, as PURE mappings so the delegated
 * listener in instrumentation-client.ts stays two lines of wiring. Same
 * shape discipline as the product observatory (ADR-0095): named events,
 * closed property sets, nothing free-text — a click on an unrecognized
 * link maps to NOTHING, never to a generic event carrying the href.
 */

describe("marketingEventForClick", () => {
  it("the DMG artifact is the conversion", () => {
    expect(
      marketingEventForClick("https://download.getmuon.com/MUON-latest-arm64.dmg")
    ).toEqual({ name: "download_clicked", properties: { target: "dmg" } });
  });

  it("checksums count as download intent, distinctly", () => {
    expect(
      marketingEventForClick("https://download.getmuon.com/SHA256SUMS")
    ).toEqual({ name: "download_clicked", properties: { target: "checksums" } });
  });

  it("an internal /download CTA is the funnel step before the artifact", () => {
    expect(marketingEventForClick("/download")).toEqual({
      name: "download_clicked",
      properties: { target: "page" },
    });
    expect(
      marketingEventForClick("https://getmuon.com/download")
    ).toEqual({ name: "download_clicked", properties: { target: "page" } });
  });

  it("the public OSS repo is github_clicked", () => {
    expect(
      marketingEventForClick("https://github.com/Sweetdevil144/muon")
    ).toEqual({ name: "github_clicked", properties: {} });
    expect(
      marketingEventForClick("https://github.com/Sweetdevil144/muon/releases")
    ).toEqual({ name: "github_clicked", properties: {} });
  });

  it("every other link maps to NOTHING — no generic event ever carries an href", () => {
    expect(marketingEventForClick("https://docs.getmuon.com")).toBeUndefined();
    expect(marketingEventForClick("/pricing")).toBeUndefined();
    expect(marketingEventForClick("")).toBeUndefined();
    expect(marketingEventForClick(undefined)).toBeUndefined();
    // A different repo on the same host is NOT our event.
    expect(
      marketingEventForClick("https://github.com/someone-else/muon")
    ).toBeUndefined();
  });
});

describe("marketingEventForPath", () => {
  it("/pricing views are pricing_viewed", () => {
    expect(marketingEventForPath("/pricing")).toEqual({
      name: "pricing_viewed",
      properties: {},
    });
    expect(marketingEventForPath("/pricing/")).toEqual({
      name: "pricing_viewed",
      properties: {},
    });
  });

  it("every other path maps to nothing", () => {
    expect(marketingEventForPath("/")).toBeUndefined();
    expect(marketingEventForPath("/download")).toBeUndefined();
    expect(marketingEventForPath("/pricing-history")).toBeUndefined();
  });
});
