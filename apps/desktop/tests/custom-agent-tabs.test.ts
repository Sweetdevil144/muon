import { describe, expect, it } from "vitest";
import type { UngovernedAgentEntry } from "@muon/client";
import { UNGOVERNED_AUTHORITY } from "@muon/client";
import {
  buildCustomAgentMenu,
  customAgentTabLabel,
} from "../src/lib/custom-agent-tabs.js";

function entry(overrides: Partial<UngovernedAgentEntry> = {}): UngovernedAgentEntry {
  return {
    id: "custom:demo-agent",
    slug: "demo-agent",
    displayName: "Demo Agent",
    shortLabel: "Demo",
    iconKey: "custom-agent",
    command: "demo-bin",
    args: [],
    createdAt: new Date().toISOString(),
    authority: UNGOVERNED_AUTHORITY,
    ...overrides,
  };
}

describe("buildCustomAgentMenu", () => {
  it("renders one entry per registered agent, every one marked ungoverned", () => {
    const menu = buildCustomAgentMenu([
      entry({ id: "custom:a", slug: "a", shortLabel: "A" }),
      entry({ id: "custom:b", slug: "b", shortLabel: "B" }),
    ]);
    expect(menu).toHaveLength(2);
    for (const item of menu) {
      expect(item.ungoverned).toBe(true);
      expect(item.enabled).toBe(true);
    }
    expect(menu.map((item) => item.kind)).toEqual(["custom:a", "custom:b"]);
    expect(menu.map((item) => item.label)).toEqual(["A", "B"]);
  });

  it("returns [] for no registered agents", () => {
    expect(buildCustomAgentMenu([])).toEqual([]);
  });

  it("the detail sentence names the command and says what MUON never grants it", () => {
    const menu = buildCustomAgentMenu([
      entry({ command: "my-bin", args: ["--flag", "v"] }),
    ]);
    expect(menu[0]!.detail).toContain("my-bin --flag v");
    expect(menu[0]!.detail).toMatch(/no muon role/i);
    expect(menu[0]!.detail).toMatch(/no dispatch/i);
    expect(menu[0]!.detail).toMatch(/no brain\/mcp access/i);
  });
});

describe("customAgentTabLabel", () => {
  it("names the first tab after the entry's shortLabel, then numbers the second", () => {
    const entries = [entry({ id: "custom:x", slug: "x", shortLabel: "X" })];
    expect(customAgentTabLabel("custom:x", 1, entries)).toBe("X");
    expect(customAgentTabLabel("custom:x", 2, entries)).toBe("X 2");
  });

  it("falls back to the raw kind if the entry was removed mid-session", () => {
    expect(customAgentTabLabel("custom:gone", 1, [])).toBe("custom:gone");
  });
});
