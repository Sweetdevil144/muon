import { describe, expect, it } from "vitest";
import {
  buildPaletteCommands,
  filterPaletteCommands,
  PALETTE_COMMANDS,
} from "../src/lib/palette.js";

describe("palette", () => {
  it("returns all commands for empty query", () => {
    expect(filterPaletteCommands("")).toHaveLength(PALETTE_COMMANDS.length);
  });

  it("fuzzy-matches by label and keywords", () => {
    const results = filterPaletteCommands("approv");
    expect(results[0]?.id).toMatch(/approve|focus-approvals/);
    expect(results.some((r) => r.id === "approve")).toBe(true);
  });

  it("ranks exact id matches highest", () => {
    const results = filterPaletteCommands("quit");
    expect(results[0]?.id).toBe("quit");
  });

  it("returns empty for nonsense", () => {
    expect(filterPaletteCommands("zzzz-nope")).toEqual([]);
  });

  it("surfaces the workflow runs and specialist factory commands", () => {
    expect(filterPaletteCommands("workflow")[0]?.id).toBe("workflows");
    expect(
      filterPaletteCommands("specialist").some((r) => r.id === "specialist")
    ).toBe(true);
    expect(filterPaletteCommands("harness").some((r) => r.id === "specialist")).toBe(
      true
    );
  });

  describe("ADR-0013 #52, vendor actions merged into the palette", () => {
    const READY = [
      { vendor: "claude-code", installed: true, authenticated: true },
      { vendor: "codex", installed: true, authenticated: true },
      { vendor: "cursor", installed: true, authenticated: true },
    ];

    it("keeps the cockpit-only default intact (back-compat)", () => {
      // filterPaletteCommands default must still be exactly the cockpit set, so
      // the existing 'empty query → all commands' contract holds.
      expect(filterPaletteCommands("")).toHaveLength(PALETTE_COMMANDS.length);
    });

    it("joins the readiness-aware vendor surface when asked", () => {
      const commands = buildPaletteCommands(READY);
      expect(commands.length).toBeGreaterThan(PALETTE_COMMANDS.length);
      const ultra = commands.find((c) => c.id === "vendor:claude-code:ultrareview");
      expect(ultra).toBeTruthy();
      expect(ultra?.badge).toBe("claude");
      expect(ultra?.chip).toMatch(/clean|⚠/);
      expect(ultra?.invoke).toBe("/ultrareview [claude]");
    });

    it("marks a vendor action disabled when its vendor is not ready", () => {
      const commands = buildPaletteCommands([
        { vendor: "claude-code", installed: false, authenticated: false },
        { vendor: "codex", installed: false, authenticated: false },
        { vendor: "cursor", installed: false, authenticated: false },
      ]);
      const vendorEntries = commands.filter((c) => c.id.startsWith("vendor:"));
      expect(vendorEntries.length).toBeGreaterThan(0);
      expect(vendorEntries.every((c) => c.enabled === false)).toBe(true);
    });

    it("carries NO raw token into any palette payload (renderer hygiene)", () => {
      const serialized = JSON.stringify(buildPaletteCommands(READY));
      expect(serialized).not.toMatch(/MUON_API_TOKEN|token|secret/i);
    });
  });
});
