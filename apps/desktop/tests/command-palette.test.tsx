// @vitest-environment jsdom

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import {
  CommandPalette,
  type PaletteCommand,
} from "../src/renderer/command-palette.js";
import type { DesktopState } from "../src/shared/ipc.js";
import type { ApprovalRequest } from "@muon/client";
import { App, resolvePaletteApprovalTarget } from "../src/renderer/app.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── CommandPalette unit: filter / nav / run / a11y (fast RED harness) ─────────

function cmds(overrides: Partial<PaletteCommand>[] = []): PaletteCommand[] {
  const base: PaletteCommand[] = [
    { id: "approve", label: "Approve pending action", hint: "A", run: vi.fn() },
    { id: "reject", label: "Reject pending action", hint: "R", run: vi.fn() },
    { id: "fullauto", label: "Turn auto-approve ON", run: vi.fn() },
  ];
  return base.map((c, i) => ({ ...c, ...(overrides[i] ?? {}) }));
}

describe("CommandPalette", () => {
  it("renders a listbox with option children and aria-activedescendant", () => {
    render(
      React.createElement(CommandPalette, {
        open: true,
        commands: cmds(),
        onClose: vi.fn(),
      })
    );
    expect(screen.getByRole("dialog", { name: /command palette/i })).toBeTruthy();
    expect(screen.getByRole("listbox", { name: /commands/i })).toBeTruthy();
    const options = screen.getAllByRole("option");
    expect(options.length).toBe(3);
    // First is active by default.
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    const input = screen.getByRole("textbox", {
      name: /command palette filter/i,
    });
    expect(input.getAttribute("aria-activedescendant")).toBe("cmd-approve");
  });

  it("renders nothing when closed", () => {
    render(
      React.createElement(CommandPalette, {
        open: false,
        commands: cmds(),
        onClose: vi.fn(),
      })
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("filters commands by substring as the user types", () => {
    render(
      React.createElement(CommandPalette, {
        open: true,
        commands: cmds(),
        onClose: vi.fn(),
      })
    );
    const input = screen.getByRole("textbox", {
      name: /command palette filter/i,
    });
    fireEvent.change(input, { target: { value: "auto" } });
    const options = screen.getAllByRole("option");
    expect(options.length).toBe(1);
    expect(options[0].textContent).toMatch(/turn auto-approve on/i);
  });

  it("shows an empty state when nothing matches", () => {
    render(
      React.createElement(CommandPalette, {
        open: true,
        commands: cmds(),
        onClose: vi.fn(),
      })
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: /command palette filter/i }),
      { target: { value: "zzz-nope" } }
    );
    expect(screen.queryAllByRole("option").length).toBe(0);
    expect(screen.getByText(/no matching command/i)).toBeTruthy();
  });

  it("moves aria-selected with ArrowDown/ArrowUp and runs the active command on Enter", () => {
    const commands = cmds();
    const onClose = vi.fn();
    render(
      React.createElement(CommandPalette, { open: true, commands, onClose })
    );
    const dialog = screen.getByRole("dialog", { name: /command palette/i });
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    let options = screen.getAllByRole("option");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(commands[0].run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("omits disabled commands from the results entirely", () => {
    const commands = cmds([{ disabled: true }]);
    render(
      React.createElement(CommandPalette, {
        open: true,
        commands,
        onClose: vi.fn(),
      })
    );
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    expect(labels.some((l) => /approve pending action/i.test(l ?? ""))).toBe(
      false
    );
    expect(screen.getAllByRole("option").length).toBe(2);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      React.createElement(CommandPalette, {
        open: true,
        commands: cmds(),
        onClose,
      })
    );
    fireEvent.keyDown(
      screen.getByRole("dialog", { name: /command palette/i }),
      { key: "Escape" }
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab focus inside the palette (aria-modal=true must not leak focus)", async () => {
    const outsideBefore = document.createElement("button");
    outsideBefore.textContent = "outside-before";
    document.body.appendChild(outsideBefore);
    const outsideAfter = document.createElement("button");
    outsideAfter.textContent = "outside-after";
    document.body.appendChild(outsideAfter);

    const user = userEvent.setup();
    render(
      React.createElement(CommandPalette, {
        open: true,
        commands: cmds(),
        onClose: vi.fn(),
      })
    );
    const input = screen.getByRole("textbox", {
      name: /command palette filter/i,
    });
    expect(document.activeElement).toBe(input);

    // Forward Tab must not escape to whatever comes after in the document.
    await user.tab();
    expect(document.activeElement).toBe(input);
    expect(document.activeElement).not.toBe(outsideAfter);

    // Shift+Tab must not escape to whatever comes before either.
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(input);
    expect(document.activeElement).not.toBe(outsideBefore);

    outsideBefore.remove();
    outsideAfter.remove();
  });

  it("returns focus to the trigger element on close", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "trigger";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const view = render(
      React.createElement(CommandPalette, {
        open: true,
        commands: cmds(),
        onClose: vi.fn(),
      })
    );
    // The filter input takes focus while open.
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: /command palette filter/i })
    );
    view.rerender(
      React.createElement(CommandPalette, {
        open: false,
        commands: cmds(),
        onClose: vi.fn(),
      })
    );
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

// ── App integration: global hotkey + real handler wiring ─────────────────────

function baseState(overrides: Partial<DesktopState> = {}): DesktopState {
  return {
    online: true,
    lastError: null,
    runnerLive: true,
    settings: { apiBase: "http://localhost:4000", apiTokenSet: false },
    fullAuto: false,
    fleet: { counts: {}, agents: [] },
    chats: [
      {
        id: "chat-1",
        title: "Palette test",
        workspacePath: "/repo",
        taskId: "task-1",
        status: "active",
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:00.000Z",
      },
    ],
    approvals: [],
    tasks: [],
    dispatchJobs: [],
    auditEvents: [],
    readiness: [],
    ...overrides,
  } as unknown as DesktopState;
}

const pendingApproval = {
  id: "ap-1",
  taskId: "task-1",
  requestedBy: "codex",
  kind: "command",
  reason: "Apply the proposed workflow",
  status: "pending",
  gateTag: "[gate:dispatch_action vendor=codex action=full-auto]",
};

function mockMuon(initialState: DesktopState) {
  let state = initialState;
  const muon = {
    getState: vi.fn(async () => state),
    on: vi.fn(() => () => {}),
    streams: vi.fn().mockResolvedValue([]),
    reviewDiff: vi.fn().mockResolvedValue({ status: "degraded", reason: "not under test" }),
    workspaceReview: vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "n/a", action: "n/a" }),
    autoContext: vi.fn().mockResolvedValue(null),
    dataBoundaries: vi.fn(async () => ({ status: "degraded", reason: "not under test" })),
    preEditContext: vi.fn().mockResolvedValue(null),
    setFullAuto: vi.fn(async (enabled: boolean) => {
      state = { ...state, fullAuto: enabled };
    }),
    resolveApproval: vi.fn(async () => {}),
    stopAll: vi.fn(async () => ({ stopped: 0, requested: 0, failedJobIds: [] })),
    pickFolder: vi.fn(async () => null),
    createChat: vi.fn(async () => ({ id: "chat-new" })),
  };
  Object.assign(window, { muon });
  return muon;
}

describe("App command palette integration", () => {
  it("opens on Meta+K and closes on Escape", async () => {
    mockMuon(baseState());
    render(React.createElement(App));
    await screen.findAllByText("MUON");

    expect(screen.queryByRole("dialog", { name: /command palette/i })).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(
      screen.getByRole("dialog", { name: /command palette/i })
    ).toBeTruthy();

    fireEvent.keyDown(
      screen.getByRole("dialog", { name: /command palette/i }),
      { key: "Escape" }
    );
    expect(screen.queryByRole("dialog", { name: /command palette/i })).toBeNull();
  });

  it("opens on Ctrl+K as well", async () => {
    mockMuon(baseState());
    render(React.createElement(App));
    await screen.findAllByText("MUON");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(
      screen.getByRole("dialog", { name: /command palette/i })
    ).toBeTruthy();
  });

  it("runs Approve pending action → window.muon.resolveApproval(approved)", async () => {
    const muon = mockMuon(baseState({ approvals: [pendingApproval] as never }));
    render(React.createElement(App));
    await screen.findAllByText("MUON");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const approveRow = screen.getByText(/approve pending action/i, {
      selector: "li span",
    });
    // No kbd badge implying a palette-level 'A' shortcut: while the palette
    // is open, 'a' types into its own filter input, it does not approve.
    expect(approveRow.closest("li")?.querySelector("kbd")).toBeNull();
    fireEvent.click(approveRow);
    await waitFor(() =>
      expect(muon.resolveApproval).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "ap-1", status: "approved" })
      )
    );
  });

  it("routes a merge approval without jobId through the newest same-task job and fails closed on degraded review", async () => {
    const mergeApproval = {
      ...pendingApproval,
      id: "merge-1",
      kind: "merge",
      reason: "Ship the governed worktree",
      jobId: undefined,
    };
    const muon = mockMuon(
      baseState({
        approvals: [mergeApproval] as never,
        dispatchJobs: [
          {
            id: "job-review",
            taskId: "task-1",
            chatId: "chat-1",
            createdAt: "2026-07-22T01:00:00.000Z",
          },
        ] as never,
      })
    );
    render(React.createElement(App));
    await screen.findAllByText("MUON");

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(
      screen.getByText(/approve pending action/i, { selector: "li span" })
    );

    await waitFor(() =>
      expect(muon.reviewDiff).toHaveBeenCalledWith({ jobId: "job-review" })
    );
    expect(muon.resolveApproval).not.toHaveBeenCalled();
    expect(await screen.findByText(/graph review evidence is unavailable/i)).toBeTruthy();
  });

  it("Approve pending action is absent when no approval is pending", async () => {
    mockMuon(baseState({ approvals: [] }));
    render(React.createElement(App));
    await screen.findAllByText("MUON");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByText(/approve pending action/i)).toBeNull();
  });

  it("Turn auto-approve ON calls setFullAuto with the negation of state.fullAuto", async () => {
    const muon = mockMuon(baseState({ fullAuto: false }));
    render(React.createElement(App));
    await screen.findAllByText("MUON");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(screen.getByText(/turn auto-approve on/i));
    await waitFor(() => expect(muon.setFullAuto).toHaveBeenCalledWith(true));
  });

  // ---- multi-approval ambiguity: never approve/reject an arbitrary one ----

  const secondPendingApproval = {
    id: "ap-2",
    taskId: "task-1",
    requestedBy: "claude-code",
    kind: "command",
    reason: "Run a second full-auto action",
    status: "pending",
    gateTag: "[gate:dispatch_action vendor=claude-code action=full-auto]",
  };

  it("hides the blanket Approve/Reject entries when 2+ approvals are pending and none is focused", async () => {
    const muon = mockMuon(
      baseState({
        approvals: [pendingApproval, secondPendingApproval] as never,
      })
    );
    render(React.createElement(App));
    await screen.findAllByText("MUON");
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    // Ambiguous: never silently act on approvals[0].
    expect(screen.queryByText(/^approve pending action$/i)).toBeNull();
    expect(screen.queryByText(/^reject pending action$/i)).toBeNull();
    // The count is disclosed instead of implying a single unambiguous target.
    expect(screen.getByText(/review pending approvals \(2\)/i)).toBeTruthy();
    expect(muon.resolveApproval).not.toHaveBeenCalled();
  });

  it("re-enables Approve/Reject, targeting exactly the focused approval, once one is focused", async () => {
    const muon = mockMuon(
      baseState({
        approvals: [pendingApproval, secondPendingApproval] as never,
      })
    );
    render(React.createElement(App));
    await screen.findAllByText("MUON");

    // Focus the SECOND approval via the real IPC event the app already
    // listens for (muon:open-approval), the same path a review click uses.
    const onOpenApproval = muon.on.mock.calls.find(
      ([event]) => event === "muon:open-approval"
    )?.[1] as ((payload: { approvalId: string }) => void) | undefined;
    expect(onOpenApproval).toBeTruthy();
    onOpenApproval!({ approvalId: "ap-2" });

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(
      screen.getByText(/^approve pending action$/i, { selector: "li span" })
    );
    await waitFor(() =>
      expect(muon.resolveApproval).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "ap-2", status: "approved" })
      )
    );
    // Never the OTHER pending approval.
    expect(muon.resolveApproval).not.toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "ap-1" })
    );
  });
});

// ── resolvePaletteApprovalTarget: pure unambiguity logic ──────────────────────

describe("resolvePaletteApprovalTarget", () => {
  const a = { id: "a" } as ApprovalRequest;
  const b = { id: "b" } as ApprovalRequest;

  it("targets the focused approval regardless of list order", () => {
    expect(resolvePaletteApprovalTarget([a, b], b)).toEqual({
      approval: b,
      ambiguous: false,
    });
  });

  it("targets the single pending approval when nothing is focused", () => {
    expect(resolvePaletteApprovalTarget([a], null)).toEqual({
      approval: a,
      ambiguous: false,
    });
  });

  it("refuses to guess with 2+ pending and nothing focused", () => {
    expect(resolvePaletteApprovalTarget([a, b], null)).toEqual({
      approval: null,
      ambiguous: true,
    });
  });

  it("is unambiguous, empty-handed, and not flagged ambiguous with zero pending", () => {
    expect(resolvePaletteApprovalTarget([], null)).toEqual({
      approval: null,
      ambiguous: false,
    });
  });
});
