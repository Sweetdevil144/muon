import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./brand-mark";

describe("BrandMark", () => {
  it("renders the canonical MUON mark used by app and favicon assets", () => {
    render(<BrandMark />);

    expect(
      screen.getByRole("img", { name: "MUON" }).getAttribute("src")
    ).toBe("/muon-mark.svg");
  });

  it("keeps the ink empty quadrant on inverse marks for dark surfaces", () => {
    render(<BrandMark inverse />);

    expect(
      screen.getByRole("img", { name: "MUON" }).getAttribute("src")
    ).toBe("/muon-mark-inverse.svg");
  });
});
