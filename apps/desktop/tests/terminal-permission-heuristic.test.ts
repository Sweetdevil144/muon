import { afterEach, describe, expect, it } from "vitest";
import {
  detectionManifestRefusal,
  loadDetectionManifest,
  looksLikePermissionPrompt,
  PERMISSION_HEURISTIC_WINDOW_CHARS,
  resetDetectionManifest,
} from "../src/lib/terminal-permission-heuristic.js";

describe("looksLikePermissionPrompt (ROADMAP T2, display-only)", () => {
  it("matches common CLI confirmation phrasings", () => {
    expect(looksLikePermissionPrompt("Overwrite file? (y/n)")).toBe(true);
    expect(looksLikePermissionPrompt("Continue? [y/N]")).toBe(true);
    expect(
      looksLikePermissionPrompt("Do you want to make this edit to foo.ts?")
    ).toBe(true);
    expect(looksLikePermissionPrompt("Press Enter to continue...")).toBe(true);
    expect(
      looksLikePermissionPrompt("Do you trust the authors of this workspace?")
    ).toBe(true);
    expect(looksLikePermissionPrompt("Allow this command to run?")).toBe(true);
    expect(looksLikePermissionPrompt('Type "yes" to confirm deletion')).toBe(
      true
    );
  });

  it("does not match ordinary command output", () => {
    expect(looksLikePermissionPrompt("$ ls -la\ntotal 12\n")).toBe(false);
    expect(looksLikePermissionPrompt("Build succeeded in 1.2s")).toBe(false);
    expect(looksLikePermissionPrompt("")).toBe(false);
  });

  it("only examines the trailing window, not unbounded scrollback", () => {
    const stale = "(y/n)" + "x".repeat(PERMISSION_HEURISTIC_WINDOW_CHARS + 10);
    expect(looksLikePermissionPrompt(stale)).toBe(false);
  });
});

describe("ADR-0039 — the patterns are hot-reloadable, and a bad manifest is inert", () => {
  afterEach(() => {
    resetDetectionManifest();
  });

  it("starts on the bundled patterns, so behaviour is unchanged until overridden", () => {
    expect(looksLikePermissionPrompt("Continue? (y/n)")).toBe(true);
    expect(looksLikePermissionPrompt("npm test passed")).toBe(false);
  });

  it("picks up a new vendor prompt WITHOUT a MUON release — the whole point", () => {
    // The regex-rot failure: a vendor rewords its prompt and the dot silently
    // stops appearing until someone ships a release.
    const reworded = "Shall I go ahead with that edit?";
    expect(looksLikePermissionPrompt(reworded)).toBe(false);

    const load = loadDetectionManifest({
      version: 1,
      vendors: { "*": { permissionPrompts: ["shall i go ahead"] } },
    });
    expect(load.source).toBe("local");
    expect(load.refused).toBeUndefined();
    expect(looksLikePermissionPrompt(reworded)).toBe(true);
  });

  it("scopes a pattern to one vendor when the manifest names it", () => {
    loadDetectionManifest({
      version: 1,
      vendors: {
        "*": { permissionPrompts: ["(y/n)"] },
        codex: { permissionPrompts: ["codex needs your call"] },
      },
    });
    expect(looksLikePermissionPrompt("codex needs your call", "codex")).toBe(true);
    // A named vendor REPLACES the wildcard, so the generic pattern no longer
    // applies to it — that is what lets a user remove a false-positiving one.
    expect(looksLikePermissionPrompt("Continue? (y/n)", "codex")).toBe(false);
    expect(looksLikePermissionPrompt("Continue? (y/n)", "claude")).toBe(true);
  });

  it("keeps working on the bundled patterns when a manifest is rejected", () => {
    const load = loadDetectionManifest({ version: 99, vendors: {} });
    expect(load.source).toBe("bundled");
    expect(load.refused).toMatch(/newer than this MUON build/);
    // Degrades to exactly what MUON did before the feature, not to nothing.
    expect(looksLikePermissionPrompt("Continue? (y/n)")).toBe(true);
    expect(detectionManifestRefusal()).toBeDefined();
  });

  it("refuses a manifest that tries to carry authority, and says so", () => {
    // ADR-0039 D1. A manifest describes; it never permits.
    const load = loadDetectionManifest({
      version: 1,
      vendors: {},
      authority: { delegatable: true },
    });
    expect(load.source).toBe("bundled");
    expect(load.refused).toBeDefined();
  });
});
