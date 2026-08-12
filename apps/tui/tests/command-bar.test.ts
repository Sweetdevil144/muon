import { describe, expect, it } from "vitest";
import { parseCommandBarInput } from "../src/lib/command-bar.js";

describe("command bar parsing", () => {
  it("treats plain text as an instruction for the super-orchestrator", () => {
    expect(parseCommandBarInput("fix the login bug then add docs")).toEqual({
      type: "instruct",
      request: "fix the login bug then add docs",
    });
  });

  it("maps slash commands to palette actions", () => {
    expect(parseCommandBarInput("/run")).toEqual({
      type: "palette",
      commandId: "run",
    });
    expect(parseCommandBarInput("/session")).toEqual({
      type: "palette",
      commandId: "session-start",
    });
    expect(parseCommandBarInput("/workflows")).toEqual({
      type: "palette",
      commandId: "workflows",
    });
    expect(parseCommandBarInput("/SHIP now")).toEqual({
      type: "palette",
      commandId: "ship",
    });
    // S7: soft-archive the resumed chat from the command bar.
    expect(parseCommandBarInput("/archive-chat")).toEqual({
      type: "palette",
      commandId: "archive-chat",
    });
  });

  it("rejects empty input and unknown slash commands", () => {
    expect(parseCommandBarInput("   ").type).toBe("error");
    const unknown = parseCommandBarInput("/frobnicate");
    expect(unknown.type).toBe("error");
    if (unknown.type === "error") {
      expect(unknown.message).toContain("/frobnicate");
    }
  });

  describe("ADR-0013 #52, /<action> [vendor] vendor-action grammar", () => {
    it("parses /ultrareview [claude] <target> into a vendor action", () => {
      expect(parseCommandBarInput("/ultrareview [claude] src/app.ts")).toEqual({
        type: "vendorAction",
        actionId: "ultrareview",
        vendor: "claude-code",
        args: ["src/app.ts"],
      });
    });

    it("accepts a bare vendor selector and friendly alias", () => {
      expect(parseCommandBarInput("/plan codex")).toEqual({
        type: "vendorAction",
        actionId: "plan",
        vendor: "codex",
        args: [],
      });
    });

    it("a bare vendor action with no vendor leaves the vendor unset (MUON picks)", () => {
      expect(parseCommandBarInput("/ultrareview")).toEqual({
        type: "vendorAction",
        actionId: "ultrareview",
        vendor: undefined,
        args: [],
      });
    });

    it("keeps the MUON cockpit meaning of /plan when NO vendor is named", () => {
      // /plan is BOTH a cockpit command and a vendor action id; with no vendor
      // selector it stays the MUON planner (back-compat), not a vendor action.
      expect(parseCommandBarInput("/plan")).toEqual({
        type: "palette",
        commandId: "plan",
      });
    });

    it("an unknown vendor token is treated as a positional argument, not a vendor", () => {
      const result = parseCommandBarInput("/ultrareview nope-vendor");
      expect(result).toEqual({
        type: "vendorAction",
        actionId: "ultrareview",
        vendor: undefined,
        args: ["nope-vendor"],
      });
    });
  });
});
