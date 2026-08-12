// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DispatchJobRecord } from "@muon/client";
import { Sidebar } from "../src/renderer/sidebar.js";
import type { DesktopState } from "../src/shared/ipc.js";

// ── S7: chat delete = operator-gated soft archive (desktop sidebar) ──────────
//
// The archive ("delete") affordance must never destroy in one click. First
// click ARMS the control; a second click fires. When the chat still has live
// worker jobs the confirm label escalates so the human makes an explicit second
// decision. A failed archive is surfaced, never swallowed.

afterEach(cleanup);

function baseState(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    chats: [
      {
        id: "chat-1",
        title: "Repair parser",
        workspacePath: "/Users/dev/muon-workspace",
        status: "active",
      },
      {
        id: "chat-2",
        title: "Docs pass",
        workspacePath: "/Users/dev/other",
        status: "active",
      },
    ],
    fleet: { counts: {}, agents: [] },
    ...overrides,
  } as unknown as DesktopState;
}

function renderSidebar(
  props: Partial<React.ComponentProps<typeof Sidebar>> = {}
) {
  const onArchiveChat = props.onArchiveChat ?? vi.fn();
  render(
    React.createElement(Sidebar, {
      state: baseState(),
      activeChatId: "chat-1",
      taskTitles: new Map(),
      onSelectChat: vi.fn(),
      onArchiveChat,
      navActive: "mission" as const,
      navPendingDecisions: 0,
      navCrewActive: false,
      navFleet: [],
      onNavigate: vi.fn(),
      onNewChat: vi.fn(),
      onStepFleet: vi.fn(),
      onOpenAgent: vi.fn(),
      onToggleFullAuto: vi.fn(),
      ...props,
    })
  );
  return { onArchiveChat };
}

describe("desktop chat archive affordance (S7)", () => {
  it("renders one archive button per chat", () => {
    renderSidebar();
    expect(screen.getAllByRole("button", { name: "Archive chat" })).toHaveLength(
      2
    );
  });

  it("does NOT archive on the first click (no one-click destroy); it arms", () => {
    const { onArchiveChat } = renderSidebar();
    const [archive] = screen.getAllByRole("button", { name: "Archive chat" });
    fireEvent.click(archive);
    expect(onArchiveChat).not.toHaveBeenCalled();
    // Armed: the control relabels to a confirm and shows the armed class.
    expect(
      screen.getByRole("button", { name: "Confirm archive" })
    ).toBeTruthy();
  });

  it("archives on the SECOND click, with the chat id", () => {
    const { onArchiveChat } = renderSidebar();
    const [archive] = screen.getAllByRole("button", { name: "Archive chat" });
    fireEvent.click(archive);
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm archive" })
    );
    expect(onArchiveChat).toHaveBeenCalledTimes(1);
    expect(onArchiveChat).toHaveBeenCalledWith("chat-1");
  });

  it("clicking the archive button never selects the row (stopPropagation)", () => {
    const onSelectChat = vi.fn();
    renderSidebar({ onSelectChat });
    const [archive] = screen.getAllByRole("button", { name: "Archive chat" });
    fireEvent.click(archive);
    expect(onSelectChat).not.toHaveBeenCalled();
  });

  it("escalates the confirm label when the chat has live worker jobs", () => {
    const jobs = [
      { id: "j1", chatId: "chat-1", status: "running" },
      { id: "j2", chatId: "chat-1", status: "queued" },
    ] as unknown as DispatchJobRecord[];
    renderSidebar({ state: baseState({ dispatchJobs: jobs }) });
    const [archive] = screen.getAllByRole("button", { name: "Archive chat" });
    fireEvent.click(archive);
    // Two live jobs on chat-1 → the second confirm says what it will do to them
    // (archive stops them first, and refuses outright if it cannot).
    expect(
      screen.getByRole("button", {
        name: "Confirm archive — stops 2 active jobs first",
      })
    ).toBeTruthy();
  });

  it("does not escalate for terminal-only jobs", () => {
    const jobs = [
      { id: "j1", chatId: "chat-1", status: "done" },
    ] as unknown as DispatchJobRecord[];
    renderSidebar({ state: baseState({ dispatchJobs: jobs }) });
    const [archive] = screen.getAllByRole("button", { name: "Archive chat" });
    fireEvent.click(archive);
    expect(
      screen.getByRole("button", { name: "Confirm archive" })
    ).toBeTruthy();
  });

  it("surfaces an archive failure as an alert, never silently", () => {
    renderSidebar({
      archiveError: "Could not archive that chat: 403 Forbidden",
    });
    expect(screen.getByRole("alert").textContent).toContain("403 Forbidden");
  });
});

// ── The per-chat cancel ("stop this chat's work", not archive) ───────────────
//
// The founder asked for session-interruption at the CHAT level. It is a
// non-destructive, idempotent act, so unlike archive it needs no arm/confirm
// step — but it must only exist where there is something to stop, must never
// select the row it lives in, and must report what it actually achieved.

describe("desktop chat cancel affordance", () => {
  const liveJobs = [
    { id: "j1", chatId: "chat-1", status: "running" },
    { id: "j2", chatId: "chat-1", status: "queued" },
  ] as unknown as DispatchJobRecord[];

  it("offers no stop control for a chat with no live work", () => {
    renderSidebar({ onCancelChat: vi.fn() });
    expect(screen.queryByRole("button", { name: /^Stop / })).toBeNull();
  });

  // The stop control MOVED off this row (founder request, 2026-08-05): the
  // row's primary action is "switch to this chat", and a kill-the-crew button
  // one pixel away is a misclick waiting to happen. It was relocated to the
  // command palette, NOT deleted — losing it would have left the titlebar's
  // Stop-all (everything, everywhere) as MUON's only stop.
  it("carries NO stop control on the row, even with live work", () => {
    renderSidebar({
      state: baseState({ dispatchJobs: liveJobs }),
      onCancelChat: vi.fn(),
    });
    expect(screen.queryByRole("button", { name: /^Stop / })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Stopping this chat/ })
    ).toBeNull();
  });

  it("keeps the row's own action reachable — selecting the chat", () => {
    const onSelectChat = vi.fn();
    renderSidebar({
      state: baseState({ dispatchJobs: liveJobs }),
      onCancelChat: vi.fn(),
      onSelectChat,
    });
    fireEvent.click(screen.getByRole("button", { name: /Repair parser/i }));
    expect(onSelectChat).toHaveBeenCalledWith("chat-1");
  });

  it("still renders no listening-port chips on the row", () => {
    // `:52994 cursorsandbox` pushed the chat title out of a narrow rail and is
    // not chat identity. Port discovery still runs; this row is not its megaphone.
    renderSidebar({
      state: baseState({ dispatchJobs: liveJobs }),
      onCancelChat: vi.fn(),
    });
    expect(screen.queryByText(/^:\d+/)).toBeNull();
  });

  it("shows the honest result of the last cancel", () => {
    renderSidebar({
      state: baseState({ dispatchJobs: liveJobs }),
      onCancelChat: vi.fn(),
      cancelNotice: "Stopped 1 of 2. 1 job is still active: j1 (codex, running).",
    });
    expect(screen.getByRole("status").textContent).toContain(
      "1 job is still active"
    );
  });
});
