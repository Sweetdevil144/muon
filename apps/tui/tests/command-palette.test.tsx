import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { CommandPalette } from "../src/components/CommandPalette.js";
import { buildPaletteCommands, type PaletteCommand } from "../src/lib/palette.js";

const READY = [
  { vendor: "claude-code", installed: true, authenticated: true },
  { vendor: "codex", installed: true, authenticated: true },
  { vendor: "cursor", installed: true, authenticated: true },
];

function frame(results: PaletteCommand[], query = "ultra"): string {
  const { lastFrame } = render(
    React.createElement(CommandPalette, { query, results, selectedIndex: 0 })
  );
  return lastFrame() ?? "";
}

describe("TUI CommandPalette, ADR-0013 #52 flag surface", () => {
  it("renders a vendor action with its badge and parity/gate chip", () => {
    const commands = buildPaletteCommands(READY).filter((c) =>
      c.id.startsWith("vendor:claude-code:ultrareview")
    );
    const out = frame(commands);
    expect(out).toContain("Deep review");
    expect(out).toContain("[claude]"); // vendor badge
    expect(out).toMatch(/clean|⚠/); // parity/gate chip
  });

  it("renders a guarded action's gate chip so a footgun never looks safe", () => {
    const guarded = buildPaletteCommands(READY, []).filter((c) =>
      c.id.startsWith("vendor:claude-code:full-auto")
    );
    const out = frame(guarded, "full");
    expect(out).toContain("Full-auto");
    expect(out).toContain("needs approval");
  });

  it("still renders plain cockpit commands with no badge", () => {
    const out = frame(
      [{ id: "run", label: "Run task on lane…", keywords: [], enabled: true }],
      "run"
    );
    expect(out).toContain("Run task on lane");
    expect(out).not.toContain("[claude]");
  });

  it("explains the selected cockpit command before execution", () => {
    const out = frame(
      [{ id: "run", label: "Run task on lane…", keywords: [], enabled: true }],
      "run"
    );
    expect(out).toContain("Effect");
    expect(out).toContain("lease-fenced runner");
    expect(out).toContain("Authority");
    expect(out).toContain("Human starts the dispatch");
  });

  it("shows the selected vendor action's exact channel, gate, and argument contract", () => {
    const command = buildPaletteCommands(READY, []).find(
      (candidate) => candidate.id === "vendor:codex:model"
    );
    expect(command).toBeDefined();

    const out = frame([command!], "model");
    expect(out).toContain("Channel");
    expect(out).toContain("profile setting");
    expect(out).toContain("Gate");
    expect(out).toContain("none");
    expect(out).toContain("Argument");
    expect(out).toContain("model (required)");
  });
});
