/**
 * The first screen a new user ever sees must not be cut in half.
 *
 * Reported from a real curl install: the "Verify your GitHub identity" card
 * rendered clipped against the left edge of the window, its heading reading
 * "…our GitHub identity". The cause was not the card — it was that the gate
 * screen carries `.app quiet` for the base surface, which brings
 * `.app.quiet`'s three-track grid, and `--sidebar-w` has a real 248px default
 * in `:root`. `place-items: center` then centred a 30rem card inside a 248px
 * column, so it overflowed ~116px off each side.
 *
 * These read the stylesheet rather than a jsdom layout because jsdom does not
 * do grid layout at all — it would happily "pass" while the shipped CSS was
 * broken, which is exactly how this shipped in the first place.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(
  fileURLToPath(new URL("../src/renderer/styles.css", import.meta.url)),
  "utf8"
);

function rule(selector: string): string {
  const at = CSS.indexOf(selector);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  const close = CSS.indexOf("}", open);
  return CSS.slice(open, close);
}

describe("the GitHub identity gate screen", () => {
  it("collapses the app's three-track grid to a single full-width column", () => {
    const body = rule(".app.quiet.github-gate-screen");
    expect(body).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("out-specifies .app.quiet, or the override silently loses the cascade", () => {
    // `.github-gate-screen` alone is (0,1,0) — LESS specific than `.app.quiet`
    // at (0,2,0) — so a well-meaning simplification back to the bare class
    // would restore the bug with no visible diff in the rule body.
    const appQuiet = CSS.indexOf(".app.quiet {");
    const override = CSS.indexOf(".app.quiet.github-gate-screen");
    expect(override).toBeGreaterThan(-1);
    expect(CSS.slice(override, CSS.indexOf("{", override))).toContain(".app.quiet.github-gate-screen");
    expect(appQuiet).toBeGreaterThan(-1);
  });

  it("scrolls instead of cropping when the window is too short", () => {
    expect(rule(".app.quiet.github-gate-screen")).toContain("overflow: auto");
  });

  it("keeps the card inside the viewport on a narrow window", () => {
    const card = rule(".github-gate-card {");
    expect(card).toContain("max-width: 30rem");
    expect(card).toContain("width: 100%");
  });
});
