import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const svg = readFileSync("src/renderer/assets/muon-mark.svg", "utf8");
const styles = readFileSync("src/renderer/styles.css", "utf8");

describe("titlebar mark", () => {
  it("renders the real MUON Bauhaus quadrant mark (blue TL, red TR, yellow BL, ink BR)", () => {
    // assets/muon-mark.svg is the real site mark (public/muon-mark.svg), replacing
    // the generated indigo checkerboard. Four brand quadrants + a 32px ink border.
    expect(svg).toMatch(/fill="#2146d0"/);   // blue top-left
    expect(svg).toMatch(/fill="#e43d2f"/);   // red top-right (quarter-circle notch)
    expect(svg).toMatch(/fill="#f4c928"/);   // yellow bottom-left
    expect(svg).toMatch(/fill="#11110f"/);   // ink bottom-right
    expect(svg).toMatch(/stroke="#11110f"/); // 32px ink inner border
    // the retired indigo mark is gone
    expect(svg).not.toMatch(/#7c8cff/);
  });

  it("stays an 18px decorative mark with no rounding (the hard ink border must not be clipped)", () => {
    expect(styles).toMatch(/\.titlebar-mark\s*\{[^}]*width:\s*18px;/);
    expect(styles).toMatch(/\.titlebar-mark\s*\{[^}]*height:\s*18px;/);
    expect(styles).toMatch(/\.titlebar-mark\s*\{[^}]*border-radius:\s*0;/);
  });
});
