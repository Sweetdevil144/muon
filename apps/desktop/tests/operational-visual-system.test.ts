import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/renderer/styles.css", "utf8");

/** WCAG relative luminance + contrast for #rrggbb, so palette legibility is a
 *  guarded fact, not a comment. */
function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const chan = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * chan[0]! + 0.7152 * chan[1]! + 0.0722 * chan[2]!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe("desktop Quiet visual system", () => {
  it("defines the Quiet dark token spine (dark-first, one accent, hairline, subtle radius)", () => {
    expect(styles).toContain("color-scheme: dark;");
    expect(styles).toMatch(/--bg:\s*#141414;/i);
    expect(styles).toMatch(/--panel:\s*#181818;/i);
    expect(styles).toMatch(/--border:\s*#2A2A2A;/i);
    // The current Quiet spine uses one softened blue for focus and selection.
    expect(styles).toMatch(/--accent:\s*#82AAFF;/i);
    // The universal border is now a 1px hairline, never the 2px hard ink rule.
    expect(styles).toMatch(/--border-hard:\s*1px solid var\(--border\);/i);
    expect(styles).not.toMatch(/--border-hard:\s*2px solid/i);
    // Radius is a subtle scale, not hard 0-geometry.
    expect(styles).toMatch(/--radius-md:\s*6px;/);
    expect(styles).not.toMatch(/--radius-md:\s*0;/);
  });

  it("carries no Bauhaus residue (warm paper, black ink, primary signal palette, hard geometry)", () => {
    expect(styles).not.toMatch(/#f2efe6/i); // warm paper
    expect(styles).not.toMatch(/#11110f/i); // black ink
    expect(styles).not.toMatch(/#2146d0/i); // bauhaus blue
    expect(styles).not.toMatch(/#2563eb/i); // navy accent (fully purged)
    expect(styles).not.toMatch(/rgba\(37,\s*99,\s*235/i); // navy accent-weak/border
    expect(styles).not.toMatch(/4px 4px 0/); // hard offset shadow
    expect(styles).not.toMatch(/6px 6px 0/);
    expect(styles).not.toMatch(/font-weight:\s*900/); // weight-900 heaviness
  });

  it("uses soft, blurred elevation (never a hard colored offset)", () => {
    expect(styles).toMatch(/--shadow-hard-sm:\s*0 1px 2px rgba\(0,\s*0,\s*0/);
    expect(styles).toMatch(/--shadow-hard-md:\s*0 3px 8px rgba\(0,\s*0,\s*0/);
  });

  it("keeps type calm — display/title/heading are weight 600, not 900", () => {
    expect(styles).toMatch(/--text-display:\s*600\b/);
    expect(styles).toMatch(/--text-title:\s*600\b/);
    expect(styles).toMatch(/--text-heading:\s*600\b/);
    // Inter/JetBrains-first stacks (SF fallback), matching the Quiet spec.
    expect(styles).toMatch(/--sans:[^;]*"Inter"/);
    expect(styles).toMatch(/--mono:[^;]*"JetBrains Mono"/);
  });

  it("guarantees legible text on the dark ground (computed WCAG contrast)", () => {
    // Primary near-white on the app background clears AAA; secondary clears AA.
    expect(contrast("#E8E8E8", "#141414")).toBeGreaterThanOrEqual(7);
    expect(contrast("#9B9B9B", "#141414")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#9B9B9B", "#181818")).toBeGreaterThanOrEqual(4.5);
    // The literal tokens back those numbers.
    expect(styles).toMatch(/--text-primary:\s*#E8E8E8;/i);
    expect(styles).toMatch(/--text-secondary:\s*#9B9B9B;/i);
  });

  it("raises the focus ring to the solid accent, with contrast/forced-colors fallbacks", () => {
    expect(styles).toMatch(
      /--focus-ring:\s*0 0 0 2px var\(--bg\), 0 0 0 4px var\(--accent\);/
    );
    expect(styles).not.toMatch(/--focus-ring:[^;]*--accent-border/);
    expect(styles).toMatch(
      /:where\(button,[\s\S]*?\[role="tab"\]\):focus-visible\s*\{[^}]*box-shadow:\s*var\(--focus-ring\);/
    );
    expect(styles).toMatch(
      /@media \(forced-colors: active\)\s*\{[\s\S]*?:focus-visible\s*\{[^}]*outline:\s*2px solid Highlight;/
    );
  });

  it("keeps the accent left-rail as the quiet selection/attention idiom", () => {
    // A 2px accent left-rail is the ONE place the accent asserts itself — kept.
    expect(styles).toMatch(
      /\.rail-empty,[\s\S]*?\.session-empty,[\s\S]*?\.brain-empty\s*\{[^}]*border-left:\s*2px solid var\(--accent\);/
    );
    expect(styles).toMatch(
      /\.dispatch-hero\.degraded,[\s\S]*?\.mission-degraded,[\s\S]*?\.runner-banner\s*\{[^}]*border-left:\s*2px solid var\(--status-warn\);/
    );
    // Task 1 (responsive Quiet frame) replaced the old pre-Quiet 960px
    // breakpoint with a set that targets `.app.quiet` directly: the dock
    // overlays at 1200px, the sidebar overlays at 900px, the left nav drops
    // to glyph-only at 720px. The guarantee here — SOME responsive
    // breakpoint exists — still holds, just at the new width.
    expect(styles).toContain("@media (max-width: 900px)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("hugs a message's role label to its body text, distinct from the between-message gap", () => {
    expect(styles).toMatch(/\.msg\s*\{[^}]*gap:\s*var\(--space-2\);/);
    expect(styles).toMatch(/\.chat-scroll\s*\{[^}]*gap:\s*var\(--s4\);/);
  });

  it("carries no dead CSS for removed inline approval card / renamed session eyebrow", () => {
    expect(styles).not.toMatch(/\.approval-card\s*\{/);
    expect(styles).not.toMatch(/\.approval-kind\s*[,{]/);
    expect(styles).not.toMatch(/\.approval-reason\s*[,{]/);
    expect(styles).not.toMatch(/\.session-eyebrow/);
    expect(styles).not.toMatch(/\.approval-acknowledgement\s*[,{]/);
  });

  it("keeps the crew-liveness dot colors in parity with the TUI (needs-attention red, not amber)", () => {
    // needs-attention must resolve to danger red, ordered after .attention to
    // win the specificity tie (matches FleetRail.livenessColor).
    expect(styles).toMatch(
      /\.activity-dot\.needs-attention\s*\{[^}]*background:\s*var\(--red\);/
    );
    expect(styles).toMatch(
      /\.activity-dot\.(stalled|budget-low)[\s\S]*?\{[^}]*background:\s*var\(--yellow\);/
    );
  });

  it("holds Linear list density — the Quiet §5 row bar (28-32px), 8pt-aligned", () => {
    // The tokens ARE the density: every list row floors on var(--row) /
    // var(--row-compact). A future "just make it 40px again" regression on
    // either token re-loosens every list at once, which is exactly what this
    // guard exists to catch.
    const row = styles.match(/--row:\s*(\d+)px/)?.[1];
    const compact = styles.match(/--row-compact:\s*(\d+)px/)?.[1];
    expect(Number(row)).toBeGreaterThanOrEqual(28);
    expect(Number(row)).toBeLessThanOrEqual(32);
    expect(Number(compact)).toBeGreaterThanOrEqual(28);
    expect(Number(compact)).toBeLessThanOrEqual(32);
    expect(Number(row) % 4).toBe(0);
    expect(Number(compact) % 4).toBe(0);
  });

});
