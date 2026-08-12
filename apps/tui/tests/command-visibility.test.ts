import { describe, expect, it } from "vitest";
import { describePaletteCommand } from "../src/lib/command-visibility.js";
import { PALETTE_COMMANDS, buildPaletteCommands } from "../src/lib/palette.js";

const BANNED = [/\bbrain\b/i, /\bgoverned\b/i, /fail-closed/i];

function assertsApprovedVocabulary(text: string | undefined) {
  if (!text) return;
  for (const pattern of BANNED) {
    expect(text).not.toMatch(pattern);
  }
}

describe("command-visibility", () => {
  it("never surfaces Brain/governed/fail-closed in any cockpit command's contract", () => {
    for (const command of PALETTE_COMMANDS) {
      const details = describePaletteCommand(command);
      assertsApprovedVocabulary(details.effect);
      assertsApprovedVocabulary(details.scope);
      assertsApprovedVocabulary(details.authority);
      assertsApprovedVocabulary(details.invocation);
      assertsApprovedVocabulary(details.availability);
    }
  });

  it("never surfaces Brain/governed/fail-closed in any vendor action's contract", () => {
    const ready = [
      { vendor: "claude-code", installed: true, authenticated: true },
      { vendor: "codex", installed: true, authenticated: true },
      { vendor: "cursor", installed: true, authenticated: true },
    ];
    for (const command of buildPaletteCommands(ready)) {
      const details = describePaletteCommand(command);
      assertsApprovedVocabulary(details.effect);
      assertsApprovedVocabulary(details.scope);
      assertsApprovedVocabulary(details.authority);
      assertsApprovedVocabulary(details.channel);
      assertsApprovedVocabulary(details.gate);
    }
  });

  it("describes the pre-edit context command with the Memory vocabulary", () => {
    const details = describePaletteCommand({
      id: "context",
      label: "Pre-edit context (Memory)…",
      keywords: [],
      enabled: true,
    });
    expect(details.effect).toContain("Memory");
    expect(details.effect).not.toMatch(/\bbrain\b/i);
  });

  it("describes refresh and memory-search with confirmed/control instead of brain/governed", () => {
    const refresh = describePaletteCommand({
      id: "refresh",
      label: "Refresh control state",
      keywords: [],
      enabled: true,
    });
    expect(refresh.effect).toContain("control");

    const memorySearch = describePaletteCommand({
      id: "memory-search",
      label: "Search memory…",
      keywords: [],
      enabled: true,
    });
    expect(memorySearch.effect).toContain("confirmed memory");
  });
});
