import { describe, expect, it } from "vitest";
import {
  parseModelCommand,
  resolveModelChange,
} from "../src/renderer/lib/chat-model.js";

// ── S10: chat-level model helpers (renderer-pure) ────────────────────────────

describe("parseModelCommand (human-typed /model interception)", () => {
  it("recognises a literal leading /model <id> and returns the trimmed id", () => {
    expect(parseModelCommand("/model opus")).toEqual({ model: "opus" });
    expect(parseModelCommand("  /model   sonnet  ")).toEqual({ model: "sonnet" });
  });

  it("treats a bare /model as a reset request (empty id)", () => {
    expect(parseModelCommand("/model")).toEqual({ model: "" });
    expect(parseModelCommand("/model   ")).toEqual({ model: "" });
  });

  it("does NOT match ordinary messages or model mentions mid-sentence", () => {
    expect(parseModelCommand("use the opus model please")).toBeNull();
    expect(parseModelCommand("what /model is best?")).toBeNull();
    expect(parseModelCommand("")).toBeNull();
    // A different slash command is not a model command.
    expect(parseModelCommand("/models")).toBeNull();
  });
});

describe("resolveModelChange (fail-closed at the UI, warning relayed)", () => {
  // WAVE D: `vendor` is now REQUIRED. It used to default to a hardcoded
  // `CHAT_MODEL_VENDOR`, and these tests leaned on that default — which is
  // exactly how a latent default hides: the tests below were the only callers
  // that ever omitted the argument, and two of them were silently validating
  // against "no declared policy" rather than against Claude Code at all.
  it("accepts a known Claude Code alias with no warning", () => {
    const outcome = resolveModelChange("opus", "claude-code");
    expect(outcome).toEqual({
      kind: "set",
      model: "opus",
      note: "Model set to opus for this chat.",
    });
  });

  it("accepts an unknown-but-allowed id and relays the degrade warning (never silent)", () => {
    const outcome = resolveModelChange("gpt-9000", "claude-code");
    expect(outcome.kind).toBe("set");
    if (outcome.kind === "set") {
      expect(outcome.model).toBe("gpt-9000");
      expect(outcome.note).toContain("not a known Claude Code model");
    }
  });

  it("rejects a flag-shaped / guarded value (fail-closed) with a reason", () => {
    const dashed = resolveModelChange(
      "--dangerously-skip-permissions",
      "claude-code"
    );
    expect(dashed.kind).toBe("reject");
    expect(dashed.note.startsWith("✗")).toBe(true);
  });

  it("validates against the SEAT it was given, not a default vendor", () => {
    // The regression the required parameter closes: a Codex model id must not
    // pass as a Claude Code model just because the caller forgot to say which
    // seat is running the chat.
    const wrongSeat = resolveModelChange("gpt-5.6-sol", "claude-code");
    expect(wrongSeat.kind).toBe("set");
    if (wrongSeat.kind === "set") {
      expect(wrongSeat.note).toContain("not a known Claude Code model");
    }
    const rightSeat = resolveModelChange("gpt-5.6-sol", "codex");
    expect(rightSeat).toEqual({
      kind: "set",
      model: "gpt-5.6-sol",
      note: "Model set to gpt-5.6-sol for this chat.",
    });
  });

  it("clears to the vendor default on an empty request", () => {
    expect(resolveModelChange("", "claude-code")).toEqual({
      kind: "clear",
      note: "Model reset to the claude-code default for this chat.",
    });
    expect(resolveModelChange(null, "claude-code").kind).toBe("clear");
    expect(resolveModelChange("", "codex")).toEqual({
      kind: "clear",
      note: "Model reset to the codex default for this chat.",
    });
  });
});
