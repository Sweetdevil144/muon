import React from "react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { MuonApiClient } from "@muon/client";
import { emptyBrainSnapshot, type BrainStore } from "../src/lib/brain-store.js";
import { App } from "../src/components/App.js";
import { SLASH_COMMANDS, parseCommandBarInput } from "../src/lib/command-bar.js";
import { PALETTE_COMMANDS, filterPaletteCommands } from "../src/lib/palette.js";

/**
 * `/mcp` end to end in the cockpit: palette entry → panel → Esc, S1 of
 * docs/design/cc-as-superagent-delivery.md §5.
 *
 * HERMETIC BY REDIRECTION. `App` calls `loadMcpPanel()` with no injected IO, so
 * it uses `defaultVendorIo()` — which resolves `~` from `os.homedir()`. HOME and
 * XDG_CONFIG_HOME are pointed at a fresh `mkdtemp` for the duration, and
 * MUON_DATA_DIR too, so this test cannot READ the operator's real `~/.claude`,
 * `~/.codex`, `~/.cursor` or `~/.config/opencode` — and the panel writes
 * nothing anywhere, which is the property the assertions below also pin.
 */

const tempRoots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function redirectHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muon-tui-app-mcp-"));
  tempRoots.push(dir);
  for (const key of ["HOME", "XDG_CONFIG_HOME", "MUON_DATA_DIR"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOME = dir;
  process.env.XDG_CONFIG_HOME = path.join(dir, ".config");
  process.env.MUON_DATA_DIR = path.join(dir, "data");
  fs.mkdirSync(process.env.MUON_DATA_DIR, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  tempRoots.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  tempRoots.length = 0;
});

const SNAPSHOT = emptyBrainSnapshot();

function stubStore(): BrainStore {
  // Cached: React's useSyncExternalStore warns (and can spin) if getSnapshot
  // returns a fresh object every call.
  return {
    client: new MuonApiClient("http://localhost:4000", async () => {
      throw new Error("no network in render tests");
    }),
    getSnapshot: () => SNAPSHOT,
    subscribe: () => () => undefined,
    refresh: async () => undefined,
    start: () => undefined,
    stop: () => undefined,
  };
}

const CTRL_K = String.fromCharCode(11);
const ESC = String.fromCharCode(27);

describe("/mcp reaches the cockpit the same way every other panel does", () => {
  it("is a palette entry AND a slash command, both routed to the same id", () => {
    // Two entry points, ONE command id — a second id would be a second surface
    // to keep in sync, which is the drift §5 is written to prevent.
    expect(PALETTE_COMMANDS.some((command) => command.id === "mcp")).toBe(true);
    expect(SLASH_COMMANDS["/mcp"]).toBe("mcp");
    expect(parseCommandBarInput("/mcp")).toEqual({
      type: "palette",
      commandId: "mcp",
    });
  });

  it("is findable by the words a user would actually type", () => {
    for (const query of ["mcp", "install", "claude", "register"]) {
      expect(
        filterPaletteCommands(query).some((command) => command.id === "mcp")
      ).toBe(true);
    }
  });

  it("opens the panel from the palette and closes it on Esc", async () => {
    const home = redirectHome();
    const { stdin, lastFrame, unmount } = render(
      <App store={stubStore()} widthOverride={120} />
    );
    try {
      stdin.write(CTRL_K);
      await vi.waitFor(() =>
        expect(lastFrame() ?? "").toContain("Command palette")
      );
      stdin.write("mcp");
      await vi.waitFor(() =>
        expect(lastFrame() ?? "").toContain("MCP registration status")
      );
      stdin.write("\r");

      // The panel mounts immediately with its LOADING state and then settles —
      // a consumer never sees a blank frame while the config reads happen.
      await vi.waitFor(() =>
        expect(lastFrame() ?? "").toContain(
          "what a vendor CLI you start yourself would get"
        )
      );
      await vi.waitFor(() =>
        expect(lastFrame() ?? "").toContain("coordinatorSeat"),
        { timeout: 5000 }
      );

      stdin.write(ESC);
      await vi.waitFor(() =>
        expect(lastFrame() ?? "").not.toContain(
          "what a vendor CLI you start yourself would get"
        )
      );

      // And nothing was written into the redirected vendor-config locations.
      expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
      expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
      expect(fs.existsSync(path.join(home, ".cursor"))).toBe(false);
      expect(fs.existsSync(path.join(home, ".config", "opencode"))).toBe(false);
    } finally {
      unmount();
    }
  });
});
