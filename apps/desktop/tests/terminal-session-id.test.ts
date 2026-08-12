import { describe, expect, it } from "vitest";
import {
  chatTerminalSessionId,
  isChatTerminalSessionId,
  parseChatTerminalScope,
  parseChatTerminalSessionId,
} from "../src/lib/terminal-session-id.js";

// The human terminal-tab session-id scheme. One shape, three consumers
// (renderer builder, cwd resolver, close authorizer), so the round-trip and
// its fail-closed edges are pinned here once.

describe("chatTerminalSessionId / parse round-trip", () => {
  it("builds and parses a vendor-tab slot", () => {
    const id = chatTerminalSessionId("chat-1", "claude-code", 2);
    expect(id).toBe("terminal-chat:chat-1:claude-code.2");
    expect(parseChatTerminalSessionId(id)).toEqual({
      chatId: "chat-1",
      kind: "claude-code",
      ordinal: 2,
    });
    expect(isChatTerminalSessionId(id)).toBe(true);
  });

  it("keeps the legacy single-shell id parseable (kind/ordinal null)", () => {
    expect(parseChatTerminalSessionId("terminal-chat:chat-1")).toEqual({
      chatId: "chat-1",
      kind: null,
      ordinal: null,
    });
  });

  it("refuses to build a malformed slot instead of minting an unparseable id", () => {
    expect(() => chatTerminalSessionId("chat-1", "Claude Code", 1)).toThrow();
    expect(() => chatTerminalSessionId("chat-1", "shell", 0)).toThrow();
    expect(() => chatTerminalSessionId("chat-1", "shell", 10_000)).toThrow();
    expect(() => chatTerminalSessionId("", "shell", 1)).toThrow();
  });

  it("treats a tail that is not a strict slot as part of the chat id (fail-closed downstream)", () => {
    // No slot match ⇒ the WHOLE rest is the chat id, which an unknown-chat
    // lookup then refuses. Nothing here ever widens a spawn.
    expect(parseChatTerminalScope("chat-1:notaslot")).toEqual({
      chatId: "chat-1:notaslot",
      kind: null,
      ordinal: null,
    });
    expect(parseChatTerminalScope("chat-1:shell.0")).toEqual({
      chatId: "chat-1:shell.0",
      kind: null,
      ordinal: null,
    });
    expect(parseChatTerminalScope("")).toBeNull();
    // A slot with no chat id in front of it is NOT a slot of anything.
    expect(parseChatTerminalScope(":shell.1")).toEqual({
      chatId: ":shell.1",
      kind: null,
      ordinal: null,
    });
  });

  it("is not fooled by other session-id namespaces", () => {
    expect(isChatTerminalSessionId("terminal-job-1")).toBe(false);
    expect(isChatTerminalSessionId("pty:job:job-1:a1b2c3d4")).toBe(false);
    expect(parseChatTerminalSessionId("terminal-job-1.resume")).toBeNull();
  });
});
