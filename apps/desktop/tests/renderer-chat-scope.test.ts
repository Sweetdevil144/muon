import { describe, expect, it, vi } from "vitest";
import {
  authorizeRendererTerminalClose,
  createRendererChatOwnership,
  requireArchivableRendererChat,
  requireRendererDispatchJob,
  requireRendererRecordId,
  requireRendererTask,
  requireRendererTerminalSession,
  requireSelectedRendererChat,
  resolveRendererMcpAttachScope,
} from "../src/lib/renderer-chat-scope.js";

/** The window has bound these chats at some point in its life. */
function ownership(...chatIds: string[]) {
  const owned = createRendererChatOwnership();
  for (const chatId of chatIds) {
    owned.note(chatId);
  }
  return owned;
}

describe("renderer record ids are parsed, not trusted", () => {
  it("accepts the shapes MUON's own ids take", () => {
    expect(requireRendererRecordId("cmg1n2p3q0000abcd1234efgh", "job")).toBe(
      "cmg1n2p3q0000abcd1234efgh"
    );
    expect(requireRendererRecordId("job-1.resume", "job")).toBe(
      "job-1.resume"
    );
  });

  it("refuses anything that could be more than one path segment", () => {
    // The renderer is untrusted and this id is interpolated into a request
    // path downstream (`/api/dispatch/:jobId`). A traversal, a query, or a
    // pre-encoded separator is not an id — it is an attempt to name a
    // different route.
    for (const hostile of [
      "../chats",
      "job/../../api/settings",
      "job%2F..%2Fsettings",
      "job?x=1",
      "job#frag",
      "job id",
      "",
      "x".repeat(201),
    ]) {
      expect(() => requireRendererRecordId(hostile, "job")).toThrow(
        /not a shape MUON issues/
      );
    }
  });

  it("refuses a non-string, whatever the type said it would be", () => {
    for (const wrong of [undefined, null, 7, {}, ["job-1"]]) {
      expect(() => requireRendererRecordId(wrong, "job")).toThrow(
        /not a shape MUON issues/
      );
    }
  });
});

describe("renderer chat scope", () => {
  it("requires an exact selected chat id", () => {
    expect(requireSelectedRendererChat("chat-a", "chat-a")).toBe("chat-a");
    expect(() => requireSelectedRendererChat("chat-a", "chat-b")).toThrow(
      /outside the selected chat/
    );
  });

  it("derives MCP attach workspace from main state and refuses a foreign renderer chat", () => {
    expect(
      resolveRendererMcpAttachScope(
        "chat-a",
        "/main-bound-repo",
        "/host-home",
        { chatId: "chat-a" }
      )
    ).toEqual({ chatId: "chat-a", workspacePath: "/main-bound-repo" });

    expect(() =>
      resolveRendererMcpAttachScope(
        "chat-a",
        "/main-bound-repo",
        "/host-home",
        { chatId: "chat-b" }
      )
    ).toThrow(/outside the selected chat/);

    expect(
      resolveRendererMcpAttachScope(null, null, "/host-home", {})
    ).toEqual({ workspacePath: "/host-home" });
  });

  it("accepts only a dispatch owned by the active selected chat", async () => {
    const client = {
      getChat: vi.fn(async () => ({ id: "chat-a", status: "active" })),
      getDispatchJob: vi.fn(async () => ({
        id: "job-a",
        chatId: "chat-a",
      })),
    };
    await expect(
      requireRendererDispatchJob(client as never, "chat-a", "job-a")
    ).resolves.toEqual(expect.objectContaining({ id: "job-a" }));

    client.getDispatchJob.mockResolvedValueOnce({
      id: "job-b",
      chatId: "chat-b",
    });
    await expect(
      requireRendererDispatchJob(client as never, "chat-a", "job-b")
    ).rejects.toThrow(/selected chat/);
  });

  it("closes only standalone and job terminals owned by the active selected chat", async () => {
    const client = {
      getChat: vi.fn(async (chatId: string) => ({
        id: chatId,
        status: "active",
      })),
      getDispatchJob: vi.fn(async (jobId: string) => ({
        id: jobId,
        chatId: "chat-a",
      })),
    };

    await expect(
      requireRendererTerminalSession(
        client as never,
        "chat-a",
        "terminal-chat:chat-a"
      )
    ).resolves.toBeUndefined();
    await expect(
      requireRendererTerminalSession(
        client as never,
        "chat-a",
        "terminal-job-a"
      )
    ).resolves.toBeUndefined();
    await expect(
      requireRendererTerminalSession(
        client as never,
        "chat-a",
        "terminal-chat:chat-b"
      )
    ).rejects.toThrow(/outside the selected chat/);

    client.getDispatchJob.mockResolvedValueOnce({
      id: "job-b",
      chatId: "chat-b",
    });
    await expect(
      requireRendererTerminalSession(
        client as never,
        "chat-a",
        "terminal-job-b"
      )
    ).rejects.toThrow(/selected chat/);
    await expect(
      requireRendererTerminalSession(client as never, "chat-a", "arbitrary")
    ).rejects.toThrow(/selected chat/);
  });

  it("closes terminals by session identity without requiring selection", async () => {
    const client = {
      getChat: vi.fn(async (chatId: string) => ({
        id: chatId,
        status: "archived",
      })),
      getDispatchJob: vi.fn(async (jobId: string) => ({
        id: jobId,
        chatId: "chat-b",
      })),
    };
    // Both chats were bound by this window at some point — an ARCHIVED chat is
    // still closable, which is the whole reason selection is not required.
    const owned = ownership("chat-a", "chat-b");

    await expect(
      authorizeRendererTerminalClose(
        client as never,
        "terminal-chat:chat-a",
        owned
      )
    ).resolves.toBeUndefined();
    expect(client.getChat).toHaveBeenCalledWith("chat-a");

    await expect(
      authorizeRendererTerminalClose(client as never, "terminal-job-b", owned)
    ).resolves.toBeUndefined();
    expect(client.getDispatchJob).toHaveBeenCalledWith("job-b");

    await expect(
      authorizeRendererTerminalClose(client as never, "arbitrary", owned)
    ).rejects.toThrow(/known chat/);

    // A takeover terminal reuses its job's coordinate with a `.resume` or
    // `.fork` suffix; authorization is by the underlying JOB, so BOTH suffixes
    // are stripped. A suffix this function does not know is a session id
    // nothing in the app can authorize a close for — i.e. a pty with no way to
    // die and a fast-exit record with no way to be forgotten.
    for (const sessionId of [
      "terminal-job-b.resume",
      "terminal-job-b.fork",
    ]) {
      await expect(
        authorizeRendererTerminalClose(client as never, sessionId, owned)
      ).resolves.toBeUndefined();
      expect(client.getDispatchJob).toHaveBeenLastCalledWith("job-b");
    }

    // A vendor-tab slot ("Claude 2") closes under the CHAT it names — the
    // slot is presentation, never authority.
    await expect(
      authorizeRendererTerminalClose(
        client as never,
        "terminal-chat:chat-a:claude-code.2",
        owned
      )
    ).resolves.toBeUndefined();
    expect(client.getChat).toHaveBeenLastCalledWith("chat-a");
  });

  /**
   * T3 — THE CLOSE PATH DROPPED THE OWNERSHIP CHECK.
   *
   * Dropping the SELECTED-chat requirement is correct and stays (archive/switch
   * races flip the binding before the close IPC lands). What went with it was
   * the ownership half: the job branch awaited `getDispatchJob(jobId)` and then
   * asserted nothing about the record, so the check answered "this jobId
   * exists" — true of every job in the brain, in every mission.
   *
   * MUTATION CHECK: deleting the `requireOwnedRendererChat(ownership,
   * job.chatId)` line makes the first case below resolve instead of throwing;
   * deleting the one in the standalone branch makes the second resolve.
   */
  it("refuses a close for a job whose chat this window never bound", async () => {
    const client = {
      getChat: vi.fn(async (chatId: string) => ({
        id: chatId,
        status: "active",
      })),
      getDispatchJob: vi.fn(async (jobId: string) => ({
        id: jobId,
        // A job in a mission this window has never opened.
        chatId: "chat-foreign",
      })),
    };
    const owned = ownership("chat-a");

    await expect(
      authorizeRendererTerminalClose(
        client as never,
        "terminal-job-foreign",
        owned
      )
    ).rejects.toThrow(/has not opened/);
    // Every takeover slot is refused on the same ground, not just the plain id.
    for (const suffix of [".resume", ".fork"]) {
      await expect(
        authorizeRendererTerminalClose(
          client as never,
          `terminal-job-foreign${suffix}`,
          owned
        )
      ).rejects.toThrow(/has not opened/);
    }
  });

  it("refuses a close for a standalone terminal in a chat this window never bound", async () => {
    const client = {
      getChat: vi.fn(async (chatId: string) => ({
        id: chatId,
        status: "active",
      })),
      getDispatchJob: vi.fn(),
    };
    await expect(
      authorizeRendererTerminalClose(
        client as never,
        "terminal-chat:chat-foreign:codex.2",
        ownership("chat-a")
      )
    ).rejects.toThrow(/has not opened/);
    // Refused BEFORE the lookup: a foreign chat is not even asked about.
    expect(client.getChat).not.toHaveBeenCalled();
  });

  it("never evicts, so a long-lived window can still close an old chat's terminal", async () => {
    // An LRU here would manufacture the very defect the close path exists to
    // prevent: a pty this window opened, that nothing can authorize a close
    // for. 500 binds later, the first chat is still ours.
    const owned = createRendererChatOwnership();
    owned.note("chat-first");
    for (let index = 0; index < 500; index += 1) {
      owned.note(`chat-${index}`);
    }
    expect(owned.owns("chat-first")).toBe(true);
    expect(owned.owns("chat-never-bound")).toBe(false);
    // Null/empty are not ownership, and never become a member.
    owned.note(null);
    owned.note("");
    expect(owned.owns(null)).toBe(false);
    expect(owned.owns("")).toBe(false);
  });

  it("scopes an OPEN of a vendor-tab session to the selected chat", async () => {
    const client = {
      getChat: vi.fn(async (chatId: string) => ({
        id: chatId,
        status: "active",
      })),
      getDispatchJob: vi.fn(),
    };
    await expect(
      requireRendererTerminalSession(
        client as never,
        "chat-a",
        "terminal-chat:chat-a:codex.3"
      )
    ).resolves.toBeUndefined();
    await expect(
      requireRendererTerminalSession(
        client as never,
        "chat-a",
        "terminal-chat:chat-b:codex.3"
      )
    ).rejects.toThrow(/outside the selected chat/);
  });

  it("accepts the chat task or a task used by one of that chat's jobs", async () => {
    const client = {
      getChat: vi.fn(async () => ({
        id: "chat-a",
        taskId: "chat-task",
        status: "active",
      })),
      listDispatchJobs: vi.fn(async () => [
        { id: "job-a", taskId: "worker-task", chatId: "chat-a" },
      ]),
    };

    await expect(
      requireRendererTask(client as never, "chat-a", "chat-task")
    ).resolves.toBeUndefined();
    await expect(
      requireRendererTask(client as never, "chat-a", "worker-task")
    ).resolves.toBeUndefined();
    await expect(
      requireRendererTask(client as never, "chat-a", "foreign-task")
    ).rejects.toThrow(/selected chat/);
  });
});

/**
 * T3, second half — `muon:archiveChat` had NO renderer-scope check at all,
 * unlike nearly every neighbouring handler.
 *
 * It cannot be made selection-scoped: every sidebar row archives its own chat
 * and app.tsx handles `wasActive === false` explicitly. What it can require is
 * a shape MUON issues and a real record, resolved BEFORE the stop-everything
 * cascade runs — plus an idempotent answer for an already-archived chat so a
 * raced second click does not replay "stop every job in this chat".
 */
describe("archive authorization", () => {
  it("refuses an id that is not a shape MUON issues, without a lookup", async () => {
    const client = { getChat: vi.fn() };
    for (const hostile of ["../chats", "chat/../settings", "chat id", ""]) {
      await expect(
        requireArchivableRendererChat(client as never, hostile)
      ).rejects.toThrow(/not a shape MUON issues/);
    }
    await expect(
      requireArchivableRendererChat(client as never, undefined)
    ).rejects.toThrow(/not a shape MUON issues/);
    expect(client.getChat).not.toHaveBeenCalled();
  });

  it("resolves the record first, and reports an already-archived chat rather than throwing", async () => {
    const active = {
      getChat: vi.fn(async (chatId: string) => ({
        id: chatId,
        status: "active",
      })),
    };
    await expect(
      requireArchivableRendererChat(active as never, "chat-a")
    ).resolves.toMatchObject({ chatId: "chat-a", alreadyArchived: false });

    const archived = {
      getChat: vi.fn(async (chatId: string) => ({
        id: chatId,
        status: "archived",
      })),
    };
    await expect(
      requireArchivableRendererChat(archived as never, "chat-a")
    ).resolves.toMatchObject({ chatId: "chat-a", alreadyArchived: true });
  });

  it("propagates an unknown chat as the read failure it is", async () => {
    const client = {
      getChat: vi.fn(async () => {
        throw new Error("chat not found");
      }),
    };
    await expect(
      requireArchivableRendererChat(client as never, "chat-ghost")
    ).rejects.toThrow(/not found/);
  });
});
