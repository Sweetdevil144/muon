import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Pins Quiet UI motion: tokens, tab/panel fades, drawer transitions, and
// reduced-motion kill-switch. Source-level (jsdom doesn't run CSS animations).
const source = readFileSync(
  new URL("../src/renderer/styles.css", import.meta.url),
  "utf8"
);

describe("Quiet UI motion budget", () => {
  it("exposes the shared duration/easing tokens", () => {
    expect(source).toMatch(/--dur-fast:\s*120ms/);
    expect(source).toMatch(/--dur-med:\s*180ms/);
    expect(source).toMatch(/--dur-slow:\s*220ms/);
    expect(source).toMatch(/--ease:\s*cubic-bezier/);
    expect(source).toMatch(/--ease-out:\s*cubic-bezier/);
  });

  it("cross-fades center tabpanels / workspace shells on mount", () => {
    expect(source).toContain(".workspace-panel-shell");
    expect(source).toContain(".workspace-session-shell");
    expect(source).toMatch(
      /\[role="tabpanel"\][\s\S]*?animation:\s*fade-in\s+var\(--dur-fast\)/
    );
  });

  it("settles Graph canvas and live chat turns without theatrical scale", () => {
    expect(source).toMatch(
      /\.graph-canvas\s*\{[\s\S]*?animation:\s*fade-in\s+var\(--dur-med\)/
    );
    expect(source).toMatch(
      /\.msg-live\s*\{[\s\S]*?animation:\s*rise-up\s+var\(--dur-med\)/
    );
    expect(source).not.toMatch(/animation:[^;]*bounce/i);
    expect(source).not.toMatch(/@keyframes\s+bounce/i);
  });

  it("uses rise-up / fade-in for modal chrome (crew, palette, approval, onboarding)", () => {
    for (const sel of [
      ".crew-modal-backdrop",
      ".command-palette-overlay",
      ".approval-review-overlay",
      ".onboarding",
    ]) {
      expect(source).toContain(sel);
    }
    for (const sel of [
      ".crew-modal",
      ".command-palette",
      ".approval-review-card",
      ".onboarding-card",
    ]) {
      expect(source).toContain(sel);
    }
    expect(source).toMatch(
      /\.approval-review-card[\s\S]*?animation:\s*rise-up\s+var\(--dur-med\)/
    );
  });

  it("kills motion under prefers-reduced-motion", () => {
    expect(source).toContain("@media (prefers-reduced-motion: reduce)");
    expect(source).toContain("animation-duration: 0.01ms !important");
    expect(source).toContain("transition-duration: 0.01ms !important");
  });
});
