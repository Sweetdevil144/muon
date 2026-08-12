import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #134/#136 — "the sliding still doesn't work" ROOT CAUSE, pinned so it can
// never silently regress. Both panel dividers ARE wired and DO work above
// 1200px: `.app.quiet` there is a 3-track grid (sidebar / center / dock —
// see styles.css) and the sidebar splitter resizes track 1 (--sidebar-w).
//
// Below 1200px / 900px, two @media blocks had been left over from the OLD
// 4-column layout (nav / sidebar / center / dock) and still reserved a
// phantom `var(--nav-w)` track that no element occupies in the CURRENT
// single-sidebar layout. That put the real sidebar (grid-column: 1) on the
// WRONG track (the stale nav-w one), so the splitter's --sidebar-w write
// visually resized the CENTER instead of the sidebar — invisible at the
// 1360px dev default, which sits above both breakpoints.
//
// This is a source-level (not rendered-DOM) test — jsdom doesn't evaluate
// @media queries or resolve CSS custom properties, so the only faithful way
// to pin the FIX is to parse the actual declarations, the same technique
// tests/quickstart-optin.test.ts uses for ipcMain handler spans.
const source = readFileSync(
  new URL("../src/renderer/styles.css", import.meta.url),
  "utf8"
);

/** The `{ ... }` body of the FIRST rule whose selector text starts at
 * `selectorText` within `text` (assumes no nested braces — true for plain
 * CSS declaration blocks, which is all this pins). */
function ruleBody(text: string, selectorText: string): string {
  const at = text.indexOf(selectorText);
  expect(at, `selector not found: ${selectorText}`).toBeGreaterThanOrEqual(0);
  const braceStart = text.indexOf("{", at);
  const braceEnd = text.indexOf("}", braceStart);
  return text.slice(braceStart + 1, braceEnd);
}

/** The body of an `@media (...) { ... }` block, brace-depth aware since it
 * contains nested rule blocks. */
function mediaBlock(queryText: string): string {
  const at = source.indexOf(queryText);
  expect(at, `media query not found: ${queryText}`).toBeGreaterThanOrEqual(0);
  const braceStart = source.indexOf("{", at);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(braceStart + 1, i);
}

function gridColumnsOf(body: string): string {
  const match = body.match(/grid-template-columns:\s*([^;]+);/);
  expect(match, `no grid-template-columns in: ${body}`).toBeTruthy();
  return match![1].trim().replace(/\s+/g, " ");
}

/** Track count of a grid-template-columns value, respecting nested parens —
 * `minmax(0, 1fr)` is ONE track even though it contains a comma+space. */
function trackCount(value: string): number {
  let depth = 0;
  let count = 1;
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === " " && depth === 0) count++;
  }
  return count;
}

describe("responsive .app.quiet grid tracks (#134/#136 stale-media regression)", () => {
  it("base .app.quiet (>1200px) is a 3-track grid: sidebar, center, dock — no --nav-w", () => {
    const base = gridColumnsOf(ruleBody(source, ".app.quiet {"));
    expect(trackCount(base)).toBe(3);
    expect(base).not.toContain("--nav-w");
  });

  it("sidebar/center/dock sit at grid-column 1/2/3 — what every breakpoint's track count must match", () => {
    expect(ruleBody(source, ".app.quiet > .sidebar {")).toContain(
      "grid-column: 1;"
    );
    expect(ruleBody(source, ".app.quiet > .center {")).toContain(
      "grid-column: 2;"
    );
    expect(ruleBody(source, ".app.quiet > .context-dock {")).toContain(
      "grid-column: 3;"
    );
  });

  it("≤1200px: 2 tracks (sidebar, center) — the dock exits the grid (position: fixed), never a phantom --nav-w column", () => {
    const block = mediaBlock("@media (max-width: 1200px)");
    // The dock explicitly opts out of the grid at this width — it needs NO
    // track, so the base rule's 3 tracks correctly become 2 here, not a bug.
    expect(ruleBody(block, ".app.quiet > .context-dock {")).toContain(
      "position: fixed"
    );

    const open = gridColumnsOf(
      ruleBody(block, ".app.quiet,\n  .app.quiet.dock-hidden {")
    );
    const collapsed = gridColumnsOf(
      ruleBody(
        block,
        ".app.quiet.sidebar-hidden,\n  .app.quiet.sidebar-hidden.dock-hidden {"
      )
    );
    for (const value of [open, collapsed]) {
      expect(trackCount(value)).toBe(2);
      expect(value).not.toContain("--nav-w");
    }
    // The open variant's own track is driven by --sidebar-w (the same custom
    // property the splitter writes) — not a hardcoded/stale value.
    expect(open).toContain("var(--sidebar-w)");
    expect(open.startsWith("var(--sidebar-w) ")).toBe(true);
    expect(collapsed.startsWith("0 ")).toBe(true);
  });

  it("≤900px: 2 tracks (a hardcoded 0 + center) for EVERY .app.quiet variant — the sidebar exits the grid too", () => {
    const block = mediaBlock("@media (max-width: 900px)");
    expect(ruleBody(block, ".app.quiet > .sidebar {")).toContain(
      "position: fixed"
    );
    // Also stale---nav-w-tainted before the fix: the sidebar's own overlay
    // offset referenced the phantom nav column instead of the frame edge.
    expect(ruleBody(block, ".app.quiet > .sidebar {")).toContain("left: 0;");

    const value = gridColumnsOf(
      ruleBody(
        block,
        ".app.quiet,\n  .app.quiet.dock-hidden,\n  .app.quiet.sidebar-hidden,\n  .app.quiet.sidebar-hidden.dock-hidden {"
      )
    );
    expect(trackCount(value)).toBe(2);
    expect(value).not.toContain("--nav-w");
    expect(value.startsWith("0 ")).toBe(true);
  });

  // FIX 1 — the collapsed-hide rules. Below the breakpoints the sidebar/dock are
  // position:fixed (out of grid flow), so the 0-width grid track that hides them
  // ABOVE the breakpoint can't reach them. Both panels are now KEPT MOUNTED
  // (app.tsx), so closing one only toggles a `.context-dock-collapsed` /
  // `.sidebar-collapsed` class — which MUST carry display:none here, or a ~320px
  // inert overlay strands undismissably over the workspace. Pinned at both
  // breakpoints so the fix can never silently regress.
  it("≤1200px: collapsed dock hides via opacity/visibility/pointer-events (animated drawer, no stranded overlay)", () => {
    const block = mediaBlock("@media (max-width: 1200px)");
    const body = ruleBody(
      block,
      ".app.quiet > .context-dock.context-dock-collapsed {"
    ).replace(/\s+/g, " ");
    expect(body).toContain("opacity: 0");
    expect(body).toContain("visibility: hidden");
    expect(body).toContain("pointer-events: none");
    expect(body).toContain("transform:");
  });

  it("≤900px: sidebar-hidden hides the fixed drawer via opacity/visibility (animated, no strand)", () => {
    const block = mediaBlock("@media (max-width: 900px)");
    const body = ruleBody(
      block,
      ".app.quiet.sidebar-hidden > .sidebar {"
    ).replace(/\s+/g, " ");
    expect(body).toContain("opacity: 0");
    expect(body).toContain("visibility: hidden");
    expect(body).toContain("pointer-events: none");
    expect(body).toContain("transform:");
  });
});

describe("responsive component coverage (no horizontal page scroll)", () => {
  it("≤900px clamps overlays and fluid shells to the viewport", () => {
    const block = mediaBlock("@media (max-width: 900px)");
    expect(block).toContain(".crew-modal");
    expect(block).toContain(".command-palette");
    expect(block).toContain(".graph-workspace");
    expect(block).toContain(".workspace-panel-shell");
    expect(block).toContain("max-width: 100%");
  });

  it("≤680px densifies titlebar + composer so Mission stays usable", () => {
    const block = mediaBlock("@media (max-width: 680px)");
    expect(block).toContain(".full-auto-indicator");
    expect(block).toContain(".composer-box");
    expect(block).toContain(".graph-detail");
    expect(block).toContain(".onboarding-card");
  });
});
