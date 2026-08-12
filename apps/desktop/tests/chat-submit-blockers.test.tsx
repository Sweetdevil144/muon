// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/renderer/chat.js";
import { buildBudgetLineView } from "@muon/client/budget-view";
import type { DispatchBudget } from "@muon/client";

beforeEach(() => {
  Object.assign(window, {
    muon: {
      streams: vi.fn().mockResolvedValue([]),
    },
  });
});

afterEach(cleanup);

describe("Mission composer submit blockers", () => {
  it("blocks send when the code graph is stale", () => {
    render(
      React.createElement(ChatView, {
        chat: {
          id: "chat-1",
          title: "Repair parser",
          workspacePath: "/repo",
        },
        approvals: [],
        running: false,
        live: [],
        onSend: vi.fn(),
        onResolveApproval: vi.fn(),
        onLiveSettled: vi.fn(),
        gitnexusStatus: { status: "ready", stale: true },
      })
    );

    expect(screen.getByRole("status").textContent).toMatch(/re-index/i);
    expect(
      (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("blocks send when the mission pool is exhausted", () => {
    const budget: DispatchBudget = {
      jobId: "job-1",
      capabilityMode: "orchestrator",
      rootWallMs: 1_800_000,
      maxDescendantWallMs: 4_800_000,
      poolMs: 4_800_000,
      reservedMs: 0,
      consumedMs: 4_800_000,
      remainingMs: 0,
      deadlineAt: null,
      childrenIssued: 0,
      maxChildren: 3,
      descendantsIssued: 0,
      maxDescendants: 8,
      depth: 0,
      maxDepth: 3,
      children: [],
    };
    render(
      React.createElement(ChatView, {
        chat: {
          id: "chat-1",
          title: "Repair parser",
          workspacePath: "/repo",
        },
        approvals: [],
        running: false,
        live: [],
        onSend: vi.fn(),
        onResolveApproval: vi.fn(),
        onLiveSettled: vi.fn(),
        missionBudget: buildBudgetLineView(budget),
      })
    );

    expect(screen.getByRole("status").textContent).toMatch(/raise budget/i);
  });
});
