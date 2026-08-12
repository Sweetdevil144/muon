import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "@muon/client";
import { CrewPanel, Sidebar } from "../src/renderer/sidebar.js";
import type { DesktopState } from "../src/shared/ipc.js";

describe("desktop sidebar accessibility", () => {
  it("keeps chat workspace path and agent status/task reachable without hover", () => {
    const agents: AgentRecord[] = [
      {
        id: "agent-1",
        vendor: "codex",
        ordinal: 1,
        name: "Codex 1",
        status: "working",
        currentTaskId: "task-1",
        currentJobId: "job-1",
      } as AgentRecord,
    ];
    const state: DesktopState = {
      chats: [
        {
          id: "chat-1",
          title: "Repair parser",
          workspacePath: "/Users/dev/muon-workspace",
        },
      ],
      fleet: { counts: { codex: 1 }, agents },
    } as unknown as DesktopState;

    const html = renderToStaticMarkup(
      React.createElement(Sidebar, {
        state,
        activeChatId: null,
        taskTitles: new Map([["task-1", "Repair the parser"]]),
        onSelectChat: vi.fn(),
        onArchiveChat: vi.fn(),
        navActive: "mission" as const,
        navPendingDecisions: 0,
        navCrewActive: false,
        navFleet: [],
        onNavigate: vi.fn(),
        onNewChat: vi.fn(),
        onStepFleet: vi.fn(),
        onOpenAgent: vi.fn(),
        onToggleFullAuto: vi.fn(),
      })
    );

    // The chat workspace path stays reachable in the sidebar (mouse: title;
    // keyboard/AT: visually-hidden text).
    expect(html).toContain('title="/Users/dev/muon-workspace"');
    expect(html).toContain('class="sr-only"');
    expect(html).toContain(">/Users/dev/muon-workspace<");

    // The crew (agent status/task) moved to the Crew modal's CrewPanel — the same
    // no-hover accessibility must hold there.
    const crewHtml = renderToStaticMarkup(
      React.createElement(CrewPanel, {
        state,
        taskTitles: new Map([["task-1", "Repair the parser"]]),
        onStepFleet: vi.fn(),
        onOpenAgent: vi.fn(),
      })
    );
    expect(crewHtml).toContain('class="sr-only"');
    expect(crewHtml).toContain(
      ">Repair the parser · open this agent&#x27;s stream<"
    );
  });
});
