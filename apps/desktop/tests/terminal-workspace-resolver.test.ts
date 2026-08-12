import { describe, expect, it, vi } from "vitest";
import { resolveTerminalWorkspacePath } from "../src/lib/terminal-workspace-resolver.js";

// A4 — the real-pty terminal cwd resolver (main.ts's registerTerminalIpc
// wiring, pulled out here so it's testable without Electron). `chat:<id>` (and
// its `:<kind>.<n>` tab slots) resolve through the chat record; every other id
// is a real subagent job looked up through the injected getDispatchJob.
// Unresolvable ids always fall to null — the caller refuses the real-pty open
// rather than falling back to the app's own cwd.

describe("resolveTerminalWorkspacePath", () => {
  /**
   * THE `"shell"` BRANCH IS GONE (2026-07-30), and these two are the reason it
   * had to be. It resolved to the ambient bound workspace with no
   * archived-chat refusal — the only cwd branch without one — for a session id
   * (`terminal-shell`) that app.tsx has never emitted, and that
   * `authorizeRendererTerminalClose` routes to `getDispatchJob("shell")` → 404
   * → throw, so nothing short of app quit could kill the pty it authorized.
   *
   * MUTATION CHECK: restoring `if (jobId === "shell") return boundChatId ?
   * boundWorkspace : null;` fails the first of these (it resolves without ever
   * asking the job store) — and the parameter it read no longer exists, which
   * is the point.
   */
  it('treats "shell" as an ordinary unknown jobId — no ambient-workspace door', async () => {
    const getDispatchJob = vi.fn().mockRejectedValue(new Error("not found"));
    const result = await resolveTerminalWorkspacePath(
      "shell",
      "chat-a",
      getDispatchJob,
      vi.fn().mockResolvedValue({ status: "active" })
    );
    expect(result).toBeNull();
    // It went to the job store like any other id, rather than short-circuiting
    // to whatever workspace happened to be bound.
    expect(getDispatchJob).toHaveBeenCalledWith("shell");
  });

  it('refuses "shell" when nothing is bound, without a lookup', async () => {
    const getDispatchJob = vi.fn();
    const result = await resolveTerminalWorkspacePath(
      "shell",
      null,
      getDispatchJob,
      vi.fn()
    );
    expect(result).toBeNull();
    expect(getDispatchJob).not.toHaveBeenCalled();
  });

  it("resolves a chat terminal through the trusted chat record, not the globally bound workspace", async () => {
    const getDispatchJob = vi.fn();
    const getChat = vi.fn().mockResolvedValue({
      workspacePath: "/Users/dev/chat-b",
      status: "active",
    });
    const result = await resolveTerminalWorkspacePath(
      "chat:chat-b",
      "chat-b",
      getDispatchJob,
      getChat
    );
    expect(result).toBe("/Users/dev/chat-b");
    expect(getChat).toHaveBeenCalledWith("chat-b");
    expect(getDispatchJob).not.toHaveBeenCalled();
  });

  // Terminal-native: one human vendor/shell TAB — the slotted id
  // (`chat:<chatId>:<kind>.<n>`, terminal-session-id.ts) resolves through the
  // SAME chat record and the same bound-chat authorization as the legacy id.
  it("resolves a vendor-tab slot to the chat's workspace, same authorization as the plain id", async () => {
    const getChat = vi.fn().mockResolvedValue({
      workspacePath: "/Users/dev/chat-b",
      status: "active",
    });
    const result = await resolveTerminalWorkspacePath(
      "chat:chat-b:claude-code.2",
      "chat-b",
      vi.fn(),
      getChat
    );
    expect(result).toBe("/Users/dev/chat-b");
    expect(getChat).toHaveBeenCalledWith("chat-b");
  });

  it("refuses a vendor-tab slot for a chat that is not the selected one", async () => {
    const getChat = vi.fn();
    const result = await resolveTerminalWorkspacePath(
      "chat:chat-b:codex.1",
      "chat-a",
      vi.fn(),
      getChat
    );
    expect(result).toBeNull();
    expect(getChat).not.toHaveBeenCalled();
  });

  it("treats a malformed slot as part of the chat id — unknown chat, refused", async () => {
    const getChat = vi.fn();
    const result = await resolveTerminalWorkspacePath(
      "chat:chat-b:codex.0", // ordinal 0 is not a slot; whole rest is a chat id
      "chat-b",
      vi.fn(),
      getChat
    );
    expect(result).toBeNull();
    expect(getChat).not.toHaveBeenCalled();
  });

  it("refuses an archived chat terminal", async () => {
    const result = await resolveTerminalWorkspacePath(
      "chat:chat-old",
      "chat-old",
      vi.fn(),
      vi.fn().mockResolvedValue({
        workspacePath: "/Users/dev/old",
        status: "archived",
      })
    );
    expect(result).toBeNull();
  });

  it("resolves a real jobId through getDispatchJob's workspacePath", async () => {
    const getDispatchJob = vi.fn().mockResolvedValue({
      workspacePath: "/Users/dev/job-worktree",
      chatId: "chat-a",
    });
    const result = await resolveTerminalWorkspacePath(
      "job-123",
      "chat-a",
      getDispatchJob,
      vi.fn().mockResolvedValue({ status: "active" })
    );
    expect(result).toBe("/Users/dev/job-worktree");
    expect(getDispatchJob).toHaveBeenCalledWith("job-123");
  });

  it("refuses (null) when the job lookup has no workspacePath", async () => {
    const getDispatchJob = vi.fn().mockResolvedValue({
      workspacePath: null,
      chatId: "chat-a",
    });
    const result = await resolveTerminalWorkspacePath(
      "job-456",
      "chat-a",
      getDispatchJob,
      vi.fn().mockResolvedValue({ status: "active" })
    );
    expect(result).toBeNull();
  });

  it("refuses (null) when the job lookup throws (unknown jobId) — never falls back to the bound workspace", async () => {
    const getDispatchJob = vi.fn().mockRejectedValue(new Error("not found"));
    const result = await resolveTerminalWorkspacePath(
      "unknown-job",
      "chat-a",
      getDispatchJob,
      vi.fn().mockResolvedValue({ status: "active" })
    );
    expect(result).toBeNull();
  });

  it("refuses a chat terminal that is not the selected chat", async () => {
    const getChat = vi.fn();
    const result = await resolveTerminalWorkspacePath(
      "chat:chat-b",
      "chat-a",
      vi.fn(),
      getChat
    );
    expect(result).toBeNull();
    expect(getChat).not.toHaveBeenCalled();
  });

  it("refuses a job owned by another chat", async () => {
    const getChat = vi.fn();
    const result = await resolveTerminalWorkspacePath(
      "job-b",
      "chat-a",
      vi.fn().mockResolvedValue({
        workspacePath: "/Users/dev/chat-b",
        chatId: "chat-b",
      }),
      getChat
    );
    expect(result).toBeNull();
    expect(getChat).not.toHaveBeenCalled();
  });

  /**
   * 0038 — an ATTACH coordinate is not a SPAWN coordinate. `pty:job:<jobId>:
   * <epoch>` names a dispatched job's ALREADY-RUNNING console, which a viewer
   * reads read-only; resolving a worktree for it is precisely what would let a
   * second, ungoverned vendor CLI start. Null ⇒ the caller refuses the open.
   */
  it("refuses a live-console attach id outright — it can never become a spawn", async () => {
    const getDispatchJob = vi.fn();
    const getChat = vi.fn();
    const result = await resolveTerminalWorkspacePath(
      "pty:job:job-a:a1b2c3d4",
      "chat-a",
      getDispatchJob,
      getChat
    );
    expect(result).toBeNull();
    // Not even looked up: the shape alone disqualifies it.
    expect(getDispatchJob).not.toHaveBeenCalled();
    expect(getChat).not.toHaveBeenCalled();
  });
});
