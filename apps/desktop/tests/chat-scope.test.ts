import { describe, expect, it } from "vitest";
import { scopeDesktopStateToChat } from "../src/lib/chat-scope.js";

const chat = {
  id: "chat-new",
  title: "Fix onboarding",
  workspacePath: "/repo",
  taskId: "task-chat",
  status: "active",
  createdAt: "2026-07-16T10:00:00.000Z",
  updatedAt: "2026-07-16T10:00:00.000Z",
};

describe("scopeDesktopStateToChat", () => {
  it("keeps mission, approval, audit, proposal, and agent state inside the selected chat", () => {
    const scoped = scopeDesktopStateToChat({
      chat,
      jobs: [
        {
          id: "job-old",
          chatId: "chat-old",
          taskId: "task-old",
          brief: "PRIVATE OLD ORCHESTRATOR PROMPT",
          status: "running",
          agentId: "agent-old",
        },
        {
          id: "job-root",
          chatId: "chat-new",
          taskId: "task-chat",
          brief: "PRIVATE CURRENT ORCHESTRATOR PROMPT",
          status: "running",
          capabilityMode: "orchestrator",
          agentId: "agent-root",
        },
        {
          id: "job-child",
          chatId: "chat-new",
          taskId: "task-child",
          brief: "Implement the onboarding fix",
          status: "queued",
          parentJobId: "job-root",
          rootJobId: "job-root",
          agentId: "agent-child",
        },
      ],
      approvals: [
        { id: "approval-old", taskId: "task-old" },
        { id: "approval-child", taskId: "task-child" },
      ],
      auditEvents: [
        { id: "event-old", taskId: "task-old" },
        { id: "event-child", taskId: "task-child" },
      ],
      proposals: [
        {
          id: "proposal-old",
          chatId: "chat-old",
          workspacePath: "/repo",
          createdAt: "2026-07-16T10:02:00.000Z",
        },
        {
          id: "proposal-new",
          chatId: "chat-new",
          workspacePath: "/repo",
          createdAt: "2026-07-16T09:00:00.000Z",
        },
        {
          id: "proposal-legacy-unscoped",
          workspacePath: "/repo",
          createdAt: "2026-07-16T10:03:00.000Z",
        },
      ],
    });

    expect(scoped.jobs.map((job) => job.id)).toEqual([
      "job-root",
      "job-child",
    ]);
    expect(scoped.jobs[0]?.brief).toBe("Fix onboarding");
    expect(scoped.approvals.map((approval) => approval.id)).toEqual([
      "approval-child",
    ]);
    expect(scoped.auditEvents.map((event) => event.id)).toEqual([
      "event-child",
    ]);
    expect(scoped.proposals.map((proposal) => proposal.id)).toEqual([
      "proposal-new",
    ]);
    expect(scoped.agentIds).toEqual(new Set(["agent-root", "agent-child"]));
    expect(scoped.activeTaskId).toBe("task-chat");
  });

  // ── S8: crew-click → live stream view ─────────────────────────────────────
  // A crew agent may be running a job several delegation levels deep. Every
  // level inherits chatId from its parent at creation (dispatch.ts:913-1068),
  // so this is a regression guard: scoping must keep the WHOLE chain (and its
  // agentIds) in scope, not just the direct child, or a grandchild's crew row
  // would resolve to no chat at all.
  it("keeps grandchildren of a delegated job in scope (chatId inherits down every delegation level)", () => {
    const scoped = scopeDesktopStateToChat({
      chat,
      jobs: [
        {
          id: "job-root",
          chatId: "chat-new",
          taskId: "task-chat",
          status: "running",
          capabilityMode: "orchestrator",
          agentId: "agent-root",
        },
        {
          id: "job-child",
          chatId: "chat-new",
          taskId: "task-child",
          status: "running",
          capabilityMode: "delegate",
          parentJobId: "job-root",
          rootJobId: "job-root",
          agentId: "agent-child",
        },
        {
          id: "job-grandchild",
          chatId: "chat-new",
          taskId: "task-grandchild",
          status: "queued",
          capabilityMode: "delegate",
          parentJobId: "job-child",
          rootJobId: "job-root",
          agentId: "agent-grandchild",
        },
      ],
      approvals: [],
      auditEvents: [],
      proposals: [],
    });

    expect(scoped.jobs.map((job) => job.id)).toEqual([
      "job-root",
      "job-child",
      "job-grandchild",
    ]);
    expect(scoped.agentIds).toEqual(
      new Set(["agent-root", "agent-child", "agent-grandchild"])
    );
  });

  it("returns a clean cockpit when no chat is selected", () => {
    expect(
      scopeDesktopStateToChat({
        chat: null,
        jobs: [{ id: "job-old", chatId: "chat-old", taskId: "task-old" }],
        approvals: [{ id: "approval-old", taskId: "task-old" }],
        auditEvents: [{ id: "event-old", taskId: "task-old" }],
        proposals: [{ id: "proposal-old", workspacePath: "/repo" }],
      })
    ).toMatchObject({
      activeTaskId: null,
      jobs: [],
      approvals: [],
      auditEvents: [],
      proposals: [],
    });
  });
});
