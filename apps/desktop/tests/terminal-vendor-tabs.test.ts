import { describe, expect, it } from "vitest";
import type { VendorReadiness } from "@muon/client";
import { terminalTakeoverVendorIds } from "@muon/client/vendors";
import {
  buildTerminalVendorMenu,
  CURSOR_FIRST_RUN_HINT,
  nextTerminalOrdinal,
  SHELL_TERMINAL_KIND,
  spawnableTerminalVendorIds,
  terminalTabLabel,
  VENDOR_TERMINAL_COMMANDS,
} from "../src/lib/terminal-vendor-tabs.js";
import { TERMINAL_KINDS } from "../src/lib/terminal-spawn.js";

function readiness(overrides: Partial<VendorReadiness>): VendorReadiness {
  return {
    vendor: "claude-code",
    installed: true,
    authenticated: true,
    detail: "",
    ...overrides,
  };
}

describe("spawnable vendor set", () => {
  it("is takeover-granted AND command-declared — both must agree", () => {
    const spawnable = spawnableTerminalVendorIds();
    for (const id of spawnable) {
      expect(terminalTakeoverVendorIds()).toContain(id);
      expect(VENDOR_TERMINAL_COMMANDS[id]).not.toBeNull();
    }
    // The current registry state, pinned so a silent widening is loud: every
    // takeover grant carries a command (opencode earned both together when
    // the ADR-0022 §8 keyspace hazard closed); fake never gets a button.
    expect(spawnable).toEqual(["claude-code", "codex", "cursor", "opencode"]);
  });

  it("matches the host spawn allowlist exactly (menu and door cannot drift)", () => {
    // Every spawnable vendor is a host-resolvable KIND, and the only
    // non-vendor kind is the shell.
    const kinds = [...TERMINAL_KINDS].sort();
    expect(kinds).toEqual(
      [...spawnableTerminalVendorIds(), SHELL_TERMINAL_KIND].sort()
    );
  });
});

describe("buildTerminalVendorMenu", () => {
  it("renders every spawnable vendor plus the shell, enabled by default", () => {
    const menu = buildTerminalVendorMenu(null);
    expect(menu.map((entry) => entry.kind)).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "opencode",
      "shell",
    ]);
    expect(menu.every((entry) => entry.enabled)).toBe(true);
    expect(menu[menu.length - 1]).toMatchObject({
      kind: "shell",
      label: "Terminal",
    });
  });

  it("disables a vendor only on POSITIVE not-installed evidence, carrying the fix hint", () => {
    const menu = buildTerminalVendorMenu([
      readiness({
        vendor: "codex",
        installed: false,
        authenticated: false,
        fixHint: "brew install codex",
      }),
    ]);
    const codex = menu.find((entry) => entry.kind === "codex")!;
    expect(codex.enabled).toBe(false);
    expect(codex.detail).toBe("brew install codex");
    // No readiness row for claude-code ⇒ still enabled (the pane states a
    // missing binary in one sentence; a dead strip teaches nothing).
    expect(menu.find((entry) => entry.kind === "claude-code")!.enabled).toBe(
      true
    );
  });

  it("warns that Cursor's first-run trust prompt is keyboard-only", () => {
    // Measured on a real pty (2026-07-27): cursor-agent's "Workspace Trust
    // Required" prompt enables NO mouse reporting, so a click on "Trust this
    // workspace" cannot reach it. The founder clicked it, nothing happened,
    // and the pane read as broken — which is what produced a column of Cursor
    // tabs. MUON states it before the click instead.
    const menu = buildTerminalVendorMenu(null);
    const cursor = menu.find((entry) => entry.kind === "cursor")!;
    expect(cursor.enabled).toBe(true);
    expect(cursor.detail).toBe(CURSOR_FIRST_RUN_HINT);
    expect(cursor.detail).toMatch(/keyboard-only/i);
    expect(cursor.detail).toMatch(/mouse clicks do not reach it/i);
    // Only cursor carries it — no other button grows unrelated prose.
    for (const entry of menu) {
      if (entry.kind !== "cursor") {
        expect(entry.detail).toBeNull();
      }
    }
  });

  it("carries BOTH the sign-in caveat and the trust-prompt note for Cursor", () => {
    const menu = buildTerminalVendorMenu([
      readiness({ vendor: "cursor", installed: true, authenticated: false }),
    ]);
    const cursor = menu.find((entry) => entry.kind === "cursor")!;
    expect(cursor.enabled).toBe(true);
    expect(cursor.detail).toMatch(/not signed in/i);
    expect(cursor.detail).toContain(CURSOR_FIRST_RUN_HINT);
  });

  it("says only the install gap when the Cursor CLI is absent", () => {
    // Nothing to trust when nothing launches: the fix hint stands alone.
    const menu = buildTerminalVendorMenu([
      readiness({
        vendor: "cursor",
        installed: false,
        authenticated: false,
        fixHint: "install the Cursor agent CLI",
      }),
    ]);
    const cursor = menu.find((entry) => entry.kind === "cursor")!;
    expect(cursor.enabled).toBe(false);
    expect(cursor.detail).toBe("install the Cursor agent CLI");
  });

  it("keeps a signed-out vendor ENABLED — its own TUI login is the fix path", () => {
    const menu = buildTerminalVendorMenu([
      readiness({
        vendor: "claude-code",
        installed: true,
        authenticated: false,
      }),
    ]);
    const claude = menu.find((entry) => entry.kind === "claude-code")!;
    expect(claude.enabled).toBe(true);
    expect(claude.detail).toMatch(/not signed in/i);
  });
});

describe("tab labels and ordinals", () => {
  it("names tabs 'Claude', then 'Claude 2'; shells are 'Terminal'", () => {
    expect(terminalTabLabel("claude-code", 1)).toBe("Claude");
    expect(terminalTabLabel("claude-code", 2)).toBe("Claude 2");
    expect(terminalTabLabel(SHELL_TERMINAL_KIND, 1)).toBe("Terminal");
    expect(terminalTabLabel(SHELL_TERMINAL_KIND, 3)).toBe("Terminal 3");
  });

  it("mints max+1 per kind, so closing #1 while #2 lives never collides", () => {
    const tabs = [
      { kind: "claude-code", ordinal: 2 },
      { kind: "codex", ordinal: 1 },
    ];
    expect(nextTerminalOrdinal(tabs, "claude-code")).toBe(3);
    expect(nextTerminalOrdinal(tabs, "codex")).toBe(2);
    expect(nextTerminalOrdinal(tabs, SHELL_TERMINAL_KIND)).toBe(1);
    expect(nextTerminalOrdinal([], "cursor")).toBe(1);
  });
});
