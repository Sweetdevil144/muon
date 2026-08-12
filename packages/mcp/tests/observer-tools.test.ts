import { describe, expect, it, vi } from "vitest";
import type { MuonApiClient } from "@muon/client";
import {
  MUON_CONTEXT_TOOL_NAMES,
  MUON_COORDINATION_TOOL_NAMES,
  MUON_OBSERVER_TOOL_NAMES,
} from "@muon/protocol";
import {
  createObserverModeToolDefinitions,
  createObserverToolDefinitions,
  createToolDefinitions,
} from "../src/index.js";

function client(overrides: Partial<MuonApiClient> = {}): MuonApiClient {
  return overrides as MuonApiClient;
}

describe("Tier B attached observer inventory", () => {
  it("is the exact positive protocol list and every member is read-only", () => {
    const tools = createObserverToolDefinitions(client(), {
      apiBase: "http://127.0.0.1:4000",
      apiToken: "agent-token",
      chatId: "chat-a",
    });
    expect(tools.map((tool) => tool.name)).toEqual(MUON_OBSERVER_TOOL_NAMES);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(
      true
    );
    expect(tools.map((tool) => tool.name)).not.toContain("dispatch");
    expect(tools.map((tool) => tool.name)).not.toContain("assign_roles");
    expect(tools.map((tool) => tool.name)).not.toContain("ship");
    expect(tools.map((tool) => tool.name)).not.toContain("apply_workflow");
  });

  it("composes with base tools once, replacing rather than duplicating crew_roles", () => {
    const api = client();
    const base = createToolDefinitions(api, {});
    const tools = createObserverModeToolDefinitions(api, base, {
      apiBase: "http://127.0.0.1:4000",
      apiToken: "agent-token",
      chatId: "chat-a",
    });
    // 36 = the prior 34 + ADR-0043's question_ask/question_status, which ride
    // the base coordination tier. For an attached observer both fail closed
    // at the transport (no exact-job bearer), so the widening is inventory
    // presence only, never authority.
    expect(tools).toHaveLength(37);
    expect(tools.filter((tool) => tool.name === "crew_roles")).toHaveLength(1);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set([
        ...MUON_CONTEXT_TOOL_NAMES,
        ...MUON_COORDINATION_TOOL_NAMES,
        ...MUON_OBSERVER_TOOL_NAMES,
      ])
    );
  });

  it("refuses a chat-scoped read before touching the API when no chat is named", async () => {
    const listTasks = vi.fn();
    const tool = createObserverToolDefinitions(client({ listTasks } as never), {
      apiBase: "http://127.0.0.1:4000",
      apiToken: "agent-token",
    }).find((entry) => entry.name === "list_tasks")!;
    const result = await tool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("chatId is required");
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("confines task rows to the configured chat and refuses a mismatched argument", async () => {
    const listTasks = vi.fn().mockResolvedValue([
      {
        id: "task-a",
        title: "A",
        description: "A task",
        status: "in_progress",
        priority: "high",
        chatId: "chat-a",
      },
      {
        id: "task-b",
        title: "B",
        description: "B task",
        status: "review",
        priority: "medium",
        chatId: "chat-b",
      },
    ]);
    const tool = createObserverToolDefinitions(client({ listTasks } as never), {
      apiBase: "http://127.0.0.1:4000",
      apiToken: "agent-token",
      chatId: "chat-a",
    }).find((entry) => entry.name === "list_tasks")!;

    const result = await tool.handler({});
    expect(result.structuredContent?.tasks).toEqual([
      expect.objectContaining({ id: "task-a" }),
    ]);

    const mismatch = await tool.handler({ chatId: "chat-b" });
    expect(mismatch.isError).toBe(true);
    expect(mismatch.content[0]?.text).toContain("outside this observer's configured chat");
    expect(listTasks).toHaveBeenCalledTimes(1);
  });

  // MCP #3: with no `--chat` at install time, the fence used to be whatever
  // chat each CALL named — a "boundary" the caller supplied, wandering every
  // mission one read at a time. The first explicitly named chat now pins the
  // session.
  it("pins an unconfigured observer to its FIRST named chat", async () => {
    const listTasks = vi.fn().mockResolvedValue([
      {
        id: "task-a",
        title: "A",
        description: "A task",
        status: "in_progress",
        priority: "high",
        chatId: "chat-a",
      },
    ]);
    const tool = createObserverToolDefinitions(client({ listTasks } as never), {
      apiBase: "http://127.0.0.1:4000",
      apiToken: "agent-token",
    }).find((entry) => entry.name === "list_tasks")!;

    const first = await tool.handler({ chatId: "chat-a" });
    expect(first.isError).not.toBe(true);

    // The same chat keeps answering…
    const again = await tool.handler({ chatId: "chat-a" });
    expect(again.isError).not.toBe(true);

    // …but a second chat is now outside the session's fence.
    const wander = await tool.handler({ chatId: "chat-b" });
    expect(wander.isError).toBe(true);
    expect(wander.content[0]?.text).toContain("pinned by its first read");
    expect(listTasks).toHaveBeenCalledTimes(2);
  });

  // F1: task_context/handoff_read take a bare taskId and (on the shared agent
  // token) the backend applies no chat fence — the observer composition must
  // fence them on the task's OWN chat, or an observer reads any mission's
  // brief and handoff prose machine-wide.
  it("fences task_context to the observer's chat — a foreign task refuses", async () => {
    const getTaskDetail = vi.fn(async (taskId: string) => ({
      id: taskId,
      title: "Foreign",
      description: "secret brief",
      status: "in_progress",
      priority: "high",
      chatId: taskId === "task-own" ? "chat-a" : "chat-FOREIGN",
      assignments: [],
      approvals: [],
      events: [],
    }));
    const api = client({ getTaskDetail } as never);
    const base = createToolDefinitions(api, {});
    const tools = createObserverModeToolDefinitions(api, base, {
      apiBase: "http://127.0.0.1:4000",
      apiToken: "agent-token",
      chatId: "chat-a",
    });
    const taskContext = tools.find((tool) => tool.name === "task_context")!;

    const foreign = await taskContext.handler({ taskId: "task-foreign" });
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0]?.text).toContain("outside this observer's configured chat");
    // The fence's own lookup ran once; the base handler's full read did not
    // relay the foreign brief.
    expect(JSON.stringify(foreign)).not.toContain("secret brief");

    const own = await taskContext.handler({ taskId: "task-own" });
    // Own-chat task passes through to the base handler (whatever it returns).
    expect(own.content[0]?.text ?? "").not.toContain("outside this observer's");
  });

  it("the pin is per session (per scope), not process-global", async () => {
    const listTasks = vi.fn().mockResolvedValue([]);
    const make = () =>
      createObserverToolDefinitions(client({ listTasks } as never), {
        apiBase: "http://127.0.0.1:4000",
        apiToken: "agent-token",
      }).find((entry) => entry.name === "list_tasks")!;

    const sessionOne = make();
    const sessionTwo = make();
    await sessionOne.handler({ chatId: "chat-a" });
    // A DIFFERENT session may observe a different chat; one session may not.
    const other = await sessionTwo.handler({ chatId: "chat-b" });
    expect(other.isError).not.toBe(true);
  });
});
