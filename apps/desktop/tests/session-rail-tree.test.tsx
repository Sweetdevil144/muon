// @vitest-environment jsdom

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionSlug } from "@muon/client/session-slug";
import { App } from "../src/renderer/app.js";
import { Sidebar } from "../src/renderer/sidebar.js";
import type { DesktopState } from "../src/shared/ipc.js";

// ── H8 / H9 / H10: the project → session tree, the tree a session works in,
//    and the name a human can say out loud ─────────────────────────────────
//
// Three rules this rail must keep, in one place because they are one row:
//
//  H8  A project is CLOSED until the human is standing in it. Two workspaces
//      with two sessions each cannot be mistaken for one flat list of four.
//  H9  A row names the tree its work is actually in — from the runner's own
//      `executionPath` (ADR-0048) and from nothing else — and blocked-at-gate
//      sorts above everything, because it is the only state that cannot
//      proceed without a human.
//  H10 A row carries a speakable name AND the coordinate you paste. The slug
//      is a projection of the id; identity is still the id.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "muon");
});

type Chat = {
  id: string;
  title: string;
  workspacePath: string;
  taskId?: string;
};

type Job = {
  id: string;
  chatId: string;
  taskId: string;
  status?: string;
  executionPath?: string | null;
  capabilityMode?: string;
};

function stateWith(input: {
  chats: Chat[];
  jobs?: Job[];
  approvals?: { id: string; taskId: string; jobId?: string }[];
}): DesktopState {
  return {
    chats: input.chats.map((chat) => ({
      ...chat,
      status: "active",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    })),
    fleet: { counts: {}, agents: [] },
    fullAuto: false,
    fullAutoVendors: [],
    dispatchJobs: (input.jobs ?? []).map((job) => ({
      kind: "session",
      vendor: "claude-code",
      brief: "",
      dispatchedBy: "human",
      interruptRequested: false,
      steerMessages: [],
      capabilityMode: "orchestrator",
      status: "running",
      createdAt: "2026-08-01T00:00:00.000Z",
      ...job,
    })),
    approvals: (input.approvals ?? []).map((approval) => ({
      kind: "edit",
      status: "pending",
      requestedBy: "claude-code",
      createdAt: "2026-08-01T00:00:00.000Z",
      ...approval,
    })),
  } as unknown as DesktopState;
}

function renderRail(
  state: DesktopState,
  activeChatId: string | null,
  extra: Partial<React.ComponentProps<typeof Sidebar>> = {}
) {
  return render(
    <Sidebar
      state={state}
      activeChatId={activeChatId}
      taskTitles={new Map()}
      onSelectChat={vi.fn()}
      onArchiveChat={vi.fn()}
      navActive="mission"
      navPendingDecisions={0}
      navCrewActive={false}
      navFleet={[]}
      onNavigate={vi.fn()}
      onNewChat={vi.fn()}
      onStepFleet={vi.fn()}
      onOpenAgent={vi.fn()}
      onSetFullAutoVendors={vi.fn()}
      {...extra}
    />
  );
}

const TWO_BY_TWO: Chat[] = [
  { id: "chat-a1", title: "Alpha one", workspacePath: "/Users/dev/alpha-api" },
  { id: "chat-a2", title: "Alpha two", workspacePath: "/Users/dev/alpha-api" },
  { id: "chat-b1", title: "Beta one", workspacePath: "/Users/dev/beta-ui" },
  { id: "chat-b2", title: "Beta two", workspacePath: "/Users/dev/beta-ui" },
];

function visibleTitles(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".chat-title")
  ).map((node) => node.textContent ?? "");
}

describe("H8 — a project is closed until you are standing in it", () => {
  it("opens only the group holding the active chat", () => {
    renderRail(stateWith({ chats: TWO_BY_TWO }), "chat-b1");

    // Two workspaces × two sessions: the rail shows the two you are in, and
    // says the other project exists without spilling its sessions.
    expect(visibleTitles()).toEqual(["Beta one", "Beta two"]);
    expect(
      screen
        .getByRole("button", { name: "alpha-api — 2 sessions" })
        .getAttribute("aria-expanded")
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "beta-ui — 2 sessions" })
        .getAttribute("aria-expanded")
    ).toBe("true");
  });

  it("names the workspace and how many sessions are inside it", () => {
    renderRail(
      stateWith({
        chats: [
          TWO_BY_TWO[0]!,
          TWO_BY_TWO[1]!,
          { id: "chat-solo", title: "Solo", workspacePath: "/Users/dev/beta-ui" },
        ],
      }),
      "chat-a1"
    );

    const alpha = screen.getByRole("button", { name: "alpha-api — 2 sessions" });
    // The visible label stays the workspace LEAF (never the whole path), with
    // the count beside it, and the full path is the tooltip.
    expect(
      within(alpha).getByText("alpha-api", { selector: ".rail-group-name" })
    ).toBeTruthy();
    expect(
      within(alpha).getByText("2", { selector: ".rail-group-count" })
    ).toBeTruthy();
    expect(alpha.getAttribute("title")).toBe("/Users/dev/alpha-api");
    // A one-session project is not pluralised into a lie.
    expect(
      screen.getByRole("button", { name: "beta-ui — 1 session" })
    ).toBeTruthy();
  });

  it("keeps an explicit toggle, in both directions, when the active chat moves", () => {
    const view = renderRail(stateWith({ chats: TWO_BY_TWO }), "chat-a1");
    expect(visibleTitles()).toEqual(["Alpha one", "Alpha two"]);

    // An explicit CLOSE beats the "you are standing here" default…
    fireEvent.click(
      screen.getByRole("button", { name: "alpha-api — 2 sessions" })
    );
    // …and an explicit OPEN beats the collapsed default.
    fireEvent.click(screen.getByRole("button", { name: "beta-ui — 2 sessions" }));
    expect(visibleTitles()).toEqual(["Beta one", "Beta two"]);

    // Moving the active chat must not undo either decision: a human who parked
    // a project open (to watch it) or shut (to get it out of the way) keeps
    // that arrangement for the session.
    view.rerender(
      <Sidebar
        state={stateWith({ chats: TWO_BY_TWO })}
        activeChatId="chat-b1"
        taskTitles={new Map()}
        onSelectChat={vi.fn()}
        onArchiveChat={vi.fn()}
        navActive="mission"
        navPendingDecisions={0}
        navCrewActive={false}
        navFleet={[]}
        onNavigate={vi.fn()}
        onNewChat={vi.fn()}
        onStepFleet={vi.fn()}
        onOpenAgent={vi.fn()}
        onSetFullAutoVendors={vi.fn()}
      />
    );
    expect(visibleTitles()).toEqual(["Beta one", "Beta two"]);
    expect(
      screen
        .getByRole("button", { name: "alpha-api — 2 sessions" })
        .getAttribute("aria-expanded")
    ).toBe("false");
  });

  it("never leaves the rail with nothing in it when no chat is selected", () => {
    renderRail(stateWith({ chats: TWO_BY_TWO }), null);
    expect(visibleTitles().length).toBeGreaterThan(0);
  });
});

describe("H9 — the row names the tree the work is actually in", () => {
  it("takes the worktree from the runner's executionPath, leaf visible, full path in reach", () => {
    renderRail(
      stateWith({
        chats: [{ id: "chat-a1", title: "Alpha one", workspacePath: "/Users/dev/alpha-api", taskId: "task-1" }],
        jobs: [
          {
            id: "job-1",
            chatId: "chat-a1",
            taskId: "task-1",
            executionPath: "/Users/dev/alpha-api/.muon/worktrees/job-1",
          },
        ],
      }),
      "chat-a1"
    );

    const badge = screen.getByLabelText(
      "Worktree /Users/dev/alpha-api/.muon/worktrees/job-1"
    );
    expect(badge.textContent).toContain("job-1");
    // The whole path is recoverable from the row without opening the session.
    expect(badge.getAttribute("title")).toBe(
      "/Users/dev/alpha-api/.muon/worktrees/job-1"
    );
    // Never a branch: the row prints the path fact and nothing derived from it.
    expect(badge.textContent).not.toContain("main");
  });

  it("says `workspace`, quietly, when the run has no isolated tree", () => {
    renderRail(
      stateWith({
        chats: [{ id: "chat-a1", title: "Alpha one", workspacePath: "/Users/dev/alpha-api", taskId: "task-1" }],
        jobs: [{ id: "job-1", chatId: "chat-a1", taskId: "task-1" }],
      }),
      "chat-a1"
    );

    const marker = screen.getByText("workspace", {
      selector: ".session-tree-badge",
    });
    expect(marker.className).toContain("workspace");
    expect(marker.getAttribute("title")).toContain("/Users/dev/alpha-api");
    expect(document.querySelector(".session-tree-badge.worktree")).toBeNull();
  });

  it("shows NO tree at all for a session that has dispatched nothing", () => {
    renderRail(
      stateWith({
        chats: [
          { id: "chat-a1", title: "Alpha one", workspacePath: "/Users/dev/alpha-api" },
        ],
      }),
      "chat-a1"
    );
    expect(document.querySelector(".session-tree-badge")).toBeNull();
  });

  it("sorts blocked-at-gate above working above idle, stable within a rank", () => {
    renderRail(
      stateWith({
        chats: [
          { id: "chat-idle", title: "Idle", workspacePath: "/w", taskId: "task-idle" },
          { id: "chat-work", title: "Working", workspacePath: "/w", taskId: "task-work" },
          { id: "chat-idle2", title: "Idle two", workspacePath: "/w", taskId: "task-idle2" },
          { id: "chat-gate", title: "Blocked", workspacePath: "/w", taskId: "task-gate" },
        ],
        jobs: [
          { id: "job-idle", chatId: "chat-idle", taskId: "task-idle", status: "done" },
          { id: "job-work", chatId: "chat-work", taskId: "task-work", status: "running" },
          { id: "job-idle2", chatId: "chat-idle2", taskId: "task-idle2", status: "done" },
          { id: "job-gate", chatId: "chat-gate", taskId: "task-gate", status: "running" },
        ],
        approvals: [{ id: "gate-1", taskId: "task-gate", jobId: "job-gate" }],
      }),
      "chat-idle"
    );

    // Blocked first even though it was declared last; the two idle rows keep
    // the list's own order relative to each other.
    expect(visibleTitles()).toEqual(["Blocked", "Working", "Idle", "Idle two"]);
  });

  it("still says a gate is waiting inside a project that is closed", () => {
    renderRail(
      stateWith({
        chats: [
          { id: "chat-a1", title: "Alpha one", workspacePath: "/Users/dev/alpha-api" },
          { id: "chat-b1", title: "Beta one", workspacePath: "/Users/dev/beta-ui", taskId: "task-gate" },
        ],
        jobs: [{ id: "job-gate", chatId: "chat-b1", taskId: "task-gate" }],
        approvals: [{ id: "gate-1", taskId: "task-gate", jobId: "job-gate" }],
      }),
      "chat-a1"
    );

    // beta-ui is closed, so its row is not on screen — but putting a project
    // away must not silence the one state that needs a human.
    expect(visibleTitles()).toEqual(["Alpha one"]);
    const beta = screen.getByRole("button", {
      name: "beta-ui — 1 session, 1 blocked at a gate",
    });
    expect(beta.getAttribute("aria-expanded")).toBe("false");
    expect(
      within(beta).getByText("1", { selector: ".rail-group-blocked" })
    ).toBeTruthy();
    // A project with nothing waiting stays silent.
    expect(
      screen
        .getByRole("button", { name: "alpha-api — 1 session" })
        .querySelector(".rail-group-blocked")
    ).toBeNull();
  });
});

describe("H10 — the row is speakable and still copyable", () => {
  it("carries the job's slug next to the session coordinate", () => {
    renderRail(
      stateWith({
        chats: [{ id: "chat-a1", title: "Alpha one", workspacePath: "/Users/dev/alpha-api", taskId: "task-1" }],
        jobs: [{ id: "job-1", chatId: "chat-a1", taskId: "task-1" }],
      }),
      "chat-a1"
    );

    expect(
      screen.getByText(sessionSlug("job-1"), { selector: ".session-card-name" })
    ).toBeTruthy();
    // The coordinate is not replaced by the name — it is what gets pasted.
    expect(
      screen.getByText("session/chat-a1", { selector: ".slug-text" })
    ).toBeTruthy();
  });

  it("shows no name for a session with no job to name", () => {
    renderRail(
      stateWith({
        chats: [
          { id: "chat-a1", title: "Alpha one", workspacePath: "/Users/dev/alpha-api" },
        ],
      }),
      "chat-a1"
    );
    expect(document.querySelector(".session-card-name")).toBeNull();
  });
});

describe("H10 — a session pane is named, not coordinate-fragmented", () => {
  function appState(): DesktopState {
    return {
      online: true,
      lastError: null,
      runnerLive: true,
      settings: { apiBase: "http://localhost:4000", apiTokenSet: false },
      fleet: { counts: {}, agents: [] },
      chats: [
        {
          id: "chat-a",
          title: "Chat A",
          workspacePath: "/repo-a",
          taskId: "task-a",
          status: "active",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      approvals: [],
      tasks: [
        {
          id: "task-a",
          title: "Ship the rail",
          description: "",
          status: "in_progress",
          priority: "normal",
        },
      ],
      dispatchJobs: [
        {
          id: "job-unbound",
          kind: "session",
          vendor: "codex",
          taskId: "task-a",
          chatId: "chat-a",
          // No fleet agent answers for this job yet — the pane builds its own
          // stub, which is the name under test.
          agentId: null,
          brief: "Investigate",
          workspacePath: "/repo-a",
          status: "running",
          dispatchedBy: "orchestrator",
          interruptRequested: false,
          steerMessages: [],
          capabilityMode: "delegate",
          createdAt: "2026-08-01T00:01:00.000Z",
        },
      ],
      auditEvents: [],
      readiness: [],
    } as unknown as DesktopState;
  }

  it("names the stub from the job's slug alone, and the pane from the vendor + that slug", async () => {
    Object.assign(window, {
      muon: {
        getState: vi.fn().mockResolvedValue(appState()),
        on: vi.fn(() => () => {}),
        streams: vi.fn().mockResolvedValue([]),
        autoContext: vi.fn().mockResolvedValue(null),
        preEditContext: vi.fn().mockResolvedValue(null),
        reviewDiff: vi
          .fn()
          .mockResolvedValue({ status: "degraded", reason: "not under test" }),
        workspaceReview: vi
          .fn()
          .mockResolvedValue({ status: "degraded", reason: "n/a", action: "n/a" }),
        dataBoundaries: vi
          .fn()
          .mockResolvedValue({ status: "degraded", reason: "not under test" }),
      },
    });

    render(<App />);

    // The running subagent auto-opens its tab; opening it renders the pane.
    // D1: the stub NAME is the slug alone — consumers (the session header,
    // the tab's vendor icon) supply the vendor once; baking the raw vendor id
    // into the name rendered "Codex · codex · <slug>", the vendor twice.
    // The TAB label is the agent codename (vendor-flavored); the PANE is
    // named by the stub — slug alone.
    const tab = await screen.findByRole("tab", { name: /Codex/ });
    fireEvent.click(tab);

    // WCAG 2.5.3: the pane's accessible name is the VISIBLE header label
    // ("<vendor> · <slug>"), not the bare slug — a human reading the label out
    // loud and a human driving it by voice must be saying the same words.
    const visible = `Codex · ${sessionSlug("job-unbound")}`;
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: `${visible} session` })
      ).toBeTruthy()
    );
    // And it really is what the header shows, not merely a matching string.
    expect(screen.getByText(visible)).toBeTruthy();
  });
});
