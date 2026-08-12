import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS, parseCommandBarInput } from "../src/lib/command-bar.js";

/**
 * ADR-0028 Tier C — TUI slash commands for attach/detach. The cockpit must
 * route through the same command ids App.tsx hands to the shared
 * `attachCoordinatorFlow` / `detachCoordinatorFlow` (never a second authority
 * path). Vendor token travels as palette args; capability tokens never do.
 */
describe("TUI /mcp-attach and /mcp-detach command bar", () => {
  it("registers both slash commands", () => {
    expect(SLASH_COMMANDS["/mcp-attach"]).toBe("mcp-attach");
    expect(SLASH_COMMANDS["/mcp-detach"]).toBe("mcp-detach");
  });

  it("carries the vendor token as palette args", () => {
    expect(parseCommandBarInput("/mcp-attach claude")).toEqual({
      type: "palette",
      commandId: "mcp-attach",
      args: ["claude"],
    });
    expect(parseCommandBarInput("/mcp-detach codex")).toEqual({
      type: "palette",
      commandId: "mcp-detach",
      args: ["codex"],
    });
  });

  it("requires a vendor argument at the App layer (empty args parse cleanly)", () => {
    expect(parseCommandBarInput("/mcp-attach")).toEqual({
      type: "palette",
      commandId: "mcp-attach",
    });
  });
});
