import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { MuonApiClient } from "@muon/client";
import type { OrchestratorChatRecord } from "@muon/client";
import { emptyBrainSnapshot, type BrainSnapshot, type BrainStore } from "../src/lib/brain-store.js";
import { App } from "../src/components/App.js";

// ── S10: `/model` is REAL in the TUI — it stashes the chat-level default model
// and threads it onto the next orchestrator turn's dispatch (not just a status
// line). runChatTurn is mocked so we assert on what the turn dispatch carries.

vi.mock("@muon/orchestrator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muon/orchestrator")>();
  return {
    ...actual,
    runChatTurn: vi.fn(async () => ({ vendorSessionId: "vs-1", exitCode: 0 })),
  };
});

const CHAT: OrchestratorChatRecord = {
  id: "chat-1",
  title: "New chat",
  workspacePath: "/tmp/ws",
  taskId: "task-shadow",
  vendorSessionId: null,
  status: "active",
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
};

function stubStore(snapshot: BrainSnapshot): BrainStore {
  return {
    client: new MuonApiClient("http://localhost:4000", async () => {
      throw new Error("no network in render tests");
    }),
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    refresh: async () => undefined,
    start: () => undefined,
    stop: () => undefined,
  };
}

describe("TUI /model (S10)", () => {
  it("stashes /model and includes it as the model override on the next turn", async () => {
    const store = stubStore(emptyBrainSnapshot());
    vi.spyOn(store.client, "createChat").mockResolvedValue(CHAT);
    vi.spyOn(store.client, "getChat").mockResolvedValue({
      ...CHAT,
      vendorSessionId: "vs-1",
    });
    vi.spyOn(store.client, "listDispatchJobs").mockResolvedValue([]);
    const { runChatTurn } = await import("@muon/orchestrator");
    const runChatTurnMock = vi.mocked(runChatTurn);

    const { stdin, lastFrame, unmount } = render(
      React.createElement(App, { store, widthOverride: 160 })
    );

    // Focus the command bar (`i`), set the chat model, submit.
    stdin.write("i");
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write("/model opus");
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write("\r");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("model set to opus")
    );
    // No turn was dispatched just to set the model.
    expect(runChatTurnMock).not.toHaveBeenCalled();

    // Now a plain instruction — it carries the stashed model as the override.
    stdin.write("i");
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write("plan the migration");
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write("\r");

    await vi.waitFor(() => expect(runChatTurnMock).toHaveBeenCalled());
    expect(runChatTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "plan the migration", model: "opus" })
    );

    unmount();
  });

  it("refuses a guarded /model value fail-closed and never stashes it", async () => {
    const store = stubStore(emptyBrainSnapshot());
    vi.spyOn(store.client, "listDispatchJobs").mockResolvedValue([]);

    const { stdin, lastFrame, unmount } = render(
      React.createElement(App, { store, widthOverride: 160 })
    );

    stdin.write("i");
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write("/model --dangerously-skip-permissions");
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write("\r");
    await vi.waitFor(() =>
      expect(lastFrame() ?? "").toContain("/model rejected")
    );

    unmount();
  });
});
