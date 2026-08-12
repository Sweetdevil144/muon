import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// D4 auto-title guard — a desktop rename (chat.tsx's double-click-to-edit,
// wired through window.muon.updateChat) is only safe from being silently
// clobbered by the orchestrator's own auto-title behavior because that
// behavior is gated on `chat.title === "New chat"` (packages/orchestrator/
// src/chat.ts): once a human renames a chat away from the literal string
// "New chat", the FIRST-MESSAGE auto-title never fires again for that chat.
//
// This desktop test does NOT modify packages/ (out of scope for this UI
// track) — it READS the orchestrator source, the same technique
// tests/quickstart-optin.test.ts already uses to pin main.ts's IPC wiring,
// to pin that this exact guard string still exists. If this ever regresses
// (e.g. the guard is loosened to overwrite ANY title, or removed), a rename
// would start silently reverting on the chat's next turn — this test is the
// tripwire for that regression, from the consumer (desktop) side.
const source = readFileSync(
  new URL("../../../packages/orchestrator/src/chat.ts", import.meta.url),
  "utf8"
);

describe("auto-title guard protects a desktop rename (D4)", () => {
  it("only auto-titles a chat whose title is still literally \"New chat\"", () => {
    expect(source).toContain('chat.title === "New chat"');
  });

  it("the auto-title guard wraps the ONLY updateChat({ title }) call site in a human turn", () => {
    // Exactly one call site writes a title from a turn — not one per code
    // path — so there is nowhere else a stale title could sneak back in.
    const titleWriteSites = source.split("updateChat({ chatId: chat.id, title:").length - 1;
    expect(titleWriteSites).toBe(1);

    // That one call site is inside the `chat.title === "New chat"` guard,
    // not off on its own unconditional path.
    const guardAt = source.indexOf('chat.title === "New chat"');
    const writeAt = source.indexOf("updateChat({ chatId: chat.id, title:");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeGreaterThan(guardAt);
    // And still within the same `if` block (no unrelated code, notably no
    // second `if` that could reopen the write outside the guard, in between).
    expect(source.slice(guardAt, writeAt)).not.toMatch(/\bif\s*\(/);
  });
});
