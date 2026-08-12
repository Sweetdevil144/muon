// @vitest-environment jsdom

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VendorIcon } from "../src/renderer/vendor-icon.js";

// A1 — every vendor with a dedicated glyph, plus the fallback path for an
// unknown/future vendor id. VendorIcon must never render blank.

afterEach(cleanup);

const KNOWN_VENDORS = [
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "openai",
];

describe("VendorIcon", () => {
  it.each(KNOWN_VENDORS)("renders a distinct, decorative SVG glyph for %s", (vendor) => {
    const { container } = render(React.createElement(VendorIcon, { vendor }));
    const svg = container.querySelector("svg.vendor-icon");
    expect(svg).toBeTruthy();
    expect(svg?.closest("[aria-hidden=true]")).toBeTruthy();
    // The icon library may include a <title>, but the entire wrapper remains
    // decorative and cannot alter the surrounding control's accessible name.
    // At least one drawable child (line/path/circle/g) — never an empty shell.
    expect(svg?.children.length).toBeGreaterThan(0);
  });

  it("gives every known vendor a DISTINCT glyph (no two vendors render identical markup)", () => {
    const markups = new Set<string>();
    for (const vendor of KNOWN_VENDORS) {
      const { container } = render(React.createElement(VendorIcon, { vendor }));
      const svg = container.querySelector("svg.vendor-icon");
      markups.add(svg?.innerHTML ?? "");
      cleanup();
    }
    expect(markups.size).toBe(KNOWN_VENDORS.length);
  });

  it("gives the OpenCode lane its own branded glyph, not the fallback", () => {
    const { container: byVendor } = render(
      React.createElement(VendorIcon, { vendor: "opencode" })
    );
    const opencode = byVendor.querySelector("svg.vendor-icon")?.innerHTML ?? "";
    expect(opencode.length).toBeGreaterThan(0);
    cleanup();
    // The desktop's separate takeover/attach namespace already labels
    // `opencode`, so the managed lane and that surface resolve the SAME mark
    // rather than one of them falling to the neutral diamond.
    const { container: unknown } = render(
      React.createElement(VendorIcon, { vendor: "not-a-vendor" })
    );
    expect(unknown.querySelector("svg.vendor-icon")?.innerHTML).not.toBe(
      opencode
    );
  });

  it("falls back to a neutral glyph for an unknown vendor, never blank", () => {
    const { container } = render(
      React.createElement(VendorIcon, { vendor: "some-future-vendor" })
    );
    const svg = container.querySelector("svg.vendor-icon");
    expect(svg).toBeTruthy();
    expect(svg?.children.length).toBeGreaterThan(0);
  });

  // The topology panel is the first surface to pipe BRAIN-RESPONSE vendor
  // strings (binding.vendor, heldByVendor, fromVendor, participant.vendor)
  // straight into this component. A plain object index reaches the prototype:
  // "constructor" renders a function as a child ("Objects are not valid as a
  // React child") and "__proto__" renders Object.prototype ("Element type is
  // invalid"). Both escape to the React tree and blank the window.
  const PROTOTYPE_KEYS = [
    "constructor",
    "__proto__",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "isPrototypeOf",
  ];

  it.each(PROTOTYPE_KEYS)(
    "falls back to the neutral glyph for the prototype-keyed vendor %s — never throws",
    (vendor) => {
      expect(() =>
        render(React.createElement(VendorIcon, { vendor }))
      ).not.toThrow();
      const { container } = render(React.createElement(VendorIcon, { vendor }));
      const svgs = container.querySelectorAll("svg.vendor-icon");
      expect(svgs).toHaveLength(1);
      // Exactly the diamond outline, identical to any other unknown vendor.
      expect(svgs[0]!.getAttribute("viewBox")).toBe("0 0 16 16");
      expect(svgs[0]!.querySelectorAll("path")).toHaveLength(1);
      expect(svgs[0]!.getAttribute("aria-hidden")).toBe("true");
    }
  );

  it("renders a prototype-keyed vendor identically to any other unknown one", () => {
    const { container: unknown } = render(
      React.createElement(VendorIcon, { vendor: "some-future-vendor" })
    );
    const fallback = unknown.querySelector("svg.vendor-icon")?.outerHTML ?? "";
    expect(fallback).not.toBe("");
    cleanup();
    for (const vendor of PROTOTYPE_KEYS) {
      const { container } = render(React.createElement(VendorIcon, { vendor }));
      expect(container.querySelector("svg.vendor-icon")?.outerHTML).toBe(
        fallback
      );
      cleanup();
    }
  });

  it("defaults to 14px and honors an explicit size", () => {
    const { container: defaultContainer } = render(
      React.createElement(VendorIcon, { vendor: "codex" })
    );
    const defaultSvg = defaultContainer.querySelector("svg.vendor-icon");
    expect(defaultSvg?.getAttribute("width")).toBe("14");
    expect(defaultSvg?.getAttribute("height")).toBe("14");

    const { container: sizedContainer } = render(
      React.createElement(VendorIcon, { vendor: "codex", size: 20 })
    );
    const sizedSvg = sizedContainer.querySelector("svg.vendor-icon");
    expect(sizedSvg?.getAttribute("width")).toBe("20");
    expect(sizedSvg?.getAttribute("height")).toBe("20");
  });
});
