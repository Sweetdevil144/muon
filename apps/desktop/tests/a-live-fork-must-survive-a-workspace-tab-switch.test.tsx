// @vitest-environment jsdom

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopState } from "../src/shared/ipc.js";
import { App } from "../src/renderer/app.js";

/**
 * A LIVE FORK MUST SURVIVE A WORKSPACE-TAB SWITCH.
 *
 * The takeover pane's latch (`openedTakeover`) is plain `useState` inside
 * JobStreamTerminal, and the whole session subtree used to be rendered ONLY
 * for the active workspace tab. So clicking "Mission chat" — or any panel, or
 * any human terminal tab — unmounted the pane and the latch with it, while the
 * pty it named stayed alive in Electron main. Two consequences, both worse
 * than the deliberate "Back to this job's output" trade they were confused
 * with, because this fires on an ORDINARY tab switch:
 *
 *  - the job is still running ⇒ the port closes, the host detaches, and with
 *    no consumer to ack, PtyHost's backpressure pauses the vendor child. Coming
 *    back rebuilds a fresh XTerm over a BOUNDED byte ring — for a full-screen
 *    vendor TUI, replay from wherever the ring was trimmed to. That is exactly
 *    the corruption the human-terminal keep-mounted fix was written to prevent
 *    ("switching stopped the terminal", "the codex stream is distorted"), and
 *    the pane would go on saying it carries what the agent had done "when you
 *    clicked" about a click that is no longer the one it holds;
 *  - the job FINISHED while the human was away ⇒ the grant flips to `resume`
 *    and `terminal-host.ts` refuses any `.fork` open, so the forked child is
 *    unreachable for the life of the app with nothing in the UI saying so.
 *
 * The fix mirrors the human terminal tabs: keep the pane mounted, hide it.
 * These tests drive the real App and assert on MOUNT/UNMOUNT of the terminal
 * body, not on what is visible — jsdom happily matches text inside a `hidden`
 * container, so a visibility assertion here would pass either way.
 */

const VENDOR_SESSION_ID = "019fa2c4-5f9b-70f1-9225-03dba896d740";

/**
 * Every TerminalPreview in the app, stubbed: the real one opens a MessagePort
 * through an Electron bridge jsdom does not have. It records mounts and
 * unmounts by session id, which is the only thing that distinguishes "hidden"
 * from "gone" — and the only thing the pty actually cares about.
 */
const previewEvents = vi.hoisted(
  () => [] as { type: "mount" | "unmount"; sessionId: string }[]
);
vi.mock("../src/renderer/terminal-preview.js", async () => {
  const react = await import("react");
  return {
    TerminalPreview: (props: { sessionId: string; hidden?: boolean }) => {
      react.useEffect(() => {
        previewEvents.push({ type: "mount", sessionId: props.sessionId });
        return () => {
          previewEvents.push({ type: "unmount", sessionId: props.sessionId });
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return react.createElement("div", {
        "data-session-id": props.sessionId,
        "data-hidden": props.hidden === true ? "yes" : "no",
      });
    },
  };
});

const mountsOf = (sessionId: string) =>
  previewEvents.filter(
    (event) => event.type === "mount" && event.sessionId === sessionId
  ).length;
const unmountsOf = (sessionId: string) =>
  previewEvents.filter(
    (event) => event.type === "unmount" && event.sessionId === sessionId
  ).length;

function baseState(): DesktopState {
  return {
    online: true,
    lastError: null,
    runnerLive: true,
    // The real vendor pty is on, so a session tab lands on Terminal — which is
    // where the takeover door lives.
    realPty: true,
    settings: { apiBase: "http://localhost:4000", apiTokenSet: false },
    fleet: {
      counts: { codex: 1 },
      agents: [
        {
          id: "agent-1",
          vendor: "codex",
          name: "Codex 1",
          ordinal: 1,
          status: "working",
          currentTaskId: "task-a",
          currentJobId: "job-a",
        },
      ],
    },
    chats: [
      {
        id: "chat-a",
        title: "Chat A — onboarding fix",
        workspacePath: "/repo-a",
        status: "active",
        createdAt: "2026-07-16T09:00:00.000Z",
        updatedAt: "2026-07-16T09:00:00.000Z",
      },
    ],
    approvals: [],
    tasks: [
      {
        id: "task-a",
        title: "Investigate flaky test",
        description: "",
        status: "in_progress",
        priority: "normal",
      },
    ],
    dispatchJobs: [
      {
        id: "job-a",
        kind: "session",
        vendor: "codex",
        taskId: "task-a",
        chatId: "chat-a",
        agentId: "agent-1",
        brief: "Investigate the flaky test",
        status: "running",
        vendorSessionId: VENDOR_SESSION_ID,
        dispatchedBy: "orchestrator",
        interruptRequested: false,
        steerMessages: [],
        capabilityMode: "delegate",
        createdAt: "2026-07-16T09:31:00.000Z",
      },
    ],
    auditEvents: [],
    readiness: [
      {
        vendor: "codex",
        installed: true,
        authenticated: true,
        credentialMethod: "vendor-login",
        detail: "Codex native login is ready",
      },
    ],
  } as unknown as DesktopState;
}

function mockMuon(state: DesktopState) {
  const muon = {
    getState: vi.fn().mockResolvedValue(state),
    on: vi.fn(() => () => {}),
    streams: vi.fn().mockResolvedValue([
      {
        seq: 1,
        taskId: "task-a",
        laneId: "lane-1",
        kind: "output",
        content: "working…",
        timestamp: "2026-07-16T09:31:10.000Z",
      },
    ]),
    // The job is RUNNING, so trusted main grants a FORK — never a resume.
    jobResumeProbe: vi.fn().mockResolvedValue({
      status: "ready",
      vendor: "codex",
      sessionId: VENDOR_SESSION_ID,
      mode: "fork",
    }),
    terminal: { open: vi.fn(), close: vi.fn() },
    reviewDiff: vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "not under test" }),
    workspaceReview: vi.fn().mockResolvedValue({
      status: "degraded",
      reason: "n/a",
      action: "n/a",
    }),
    autoContext: vi.fn().mockResolvedValue(null),
    dataBoundaries: vi
      .fn()
      .mockResolvedValue({ status: "degraded", reason: "not under test" }),
    preEditContext: vi.fn().mockResolvedValue(null),
  };
  Object.assign(window, { muon });
  return muon;
}

/** Open the running job's session tab, then take the fork door. */
async function openForkPane() {
  render(React.createElement(App));
  await screen.findByText("Chat A — onboarding fix", {
    selector: ".chat-title",
  });
  // Crew → "open this agent's stream" is the app's own path to a session tab.
  fireEvent.click(screen.getByRole("button", { name: "Crew" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /open this agent's stream/i })
  );
  // The session pane lands on Terminal (realPty), where the takeover door is.
  const fork = await screen.findByRole("button", { name: "Fork into Codex" });
  fireEvent.click(fork);
  await waitFor(() =>
    expect(mountsOf("terminal-job-a.fork")).toBe(1)
  );
}

beforeEach(() => {
  previewEvents.length = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a takeover pane holding a live pty is hidden, never unmounted", () => {
  it("survives a switch to Mission chat and back, on ONE pty", async () => {
    mockMuon(baseState());
    await openForkPane();

    // An ORDINARY tab switch — not the pane's own "Back to this job's output".
    fireEvent.click(screen.getByRole("tab", { name: "Mission chat" }));
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Mission chat" }).getAttribute(
          "aria-selected"
        )
      ).toBe("true")
    );

    // THE ASSERTION THAT MATTERS: the fork's terminal body is still mounted.
    expect(unmountsOf("terminal-job-a.fork")).toBe(0);
    expect(mountsOf("terminal-job-a.fork")).toBe(1);
    // …and it is genuinely backgrounded, not stacked on top of the chat: the
    // pane shell carries `hidden`, and the body is told so it can re-measure.
    const shell = document.getElementById("workspace-panel-job-a");
    expect(shell?.hasAttribute("hidden")).toBe(true);
    expect(
      document
        .querySelector('[data-session-id="terminal-job-a.fork"]')
        ?.getAttribute("data-hidden")
    ).toBe("yes");

    // Coming back re-opens NOTHING: same pty, same scrollback, no replay.
    fireEvent.click(screen.getByRole("tab", { name: /Codex/ }));
    await waitFor(() =>
      expect(
        document.getElementById("workspace-panel-job-a")?.hasAttribute("hidden")
      ).toBe(false)
    );
    expect(mountsOf("terminal-job-a.fork")).toBe(1);
    expect(unmountsOf("terminal-job-a.fork")).toBe(0);
  });

  it("survives a switch to another SECTION of its own tab", async () => {
    // The second door onto the same defect: the section tabs unmount the
    // Terminal body just as thoroughly as the workspace tabs unmount the pane.
    mockMuon(baseState());
    await openForkPane();

    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Timeline" }).getAttribute(
          "aria-selected"
        )
      ).toBe("true")
    );
    expect(unmountsOf("terminal-job-a.fork")).toBe(0);
    expect(mountsOf("terminal-job-a.fork")).toBe(1);

    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Terminal" }).getAttribute(
          "aria-selected"
        )
      ).toBe("true")
    );
    expect(mountsOf("terminal-job-a.fork")).toBe(1);
  });

  it("keeps NO pane mounted for a job that never opened a takeover", async () => {
    // The keep-mounted set is bounded by a live pty, not by "every tab the
    // human has open": a background session pane is always one they
    // deliberately opened a terminal in.
    mockMuon(baseState());
    render(React.createElement(App));
    await screen.findByText("Chat A — onboarding fix", {
      selector: ".chat-title",
    });
    fireEvent.click(screen.getByRole("button", { name: "Crew" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /open this agent's stream/i })
    );
    await screen.findByRole("button", { name: "Fork into Codex" });

    fireEvent.click(screen.getByRole("tab", { name: "Mission chat" }));
    await waitFor(() =>
      expect(document.getElementById("workspace-panel-job-a")).toBeNull()
    );
  });

  it("drops the pane once the human leaves the takeover deliberately", async () => {
    // "Back to this job's output" IS the deliberate exit, and it must release
    // the keep-mounted claim — otherwise every job ever forked would stay
    // mounted (and polling) for the rest of the session.
    mockMuon(baseState());
    await openForkPane();

    fireEvent.click(
      screen.getByRole("button", { name: "Back to this job's output" })
    );
    await waitFor(() =>
      expect(unmountsOf("terminal-job-a.fork")).toBe(1)
    );

    fireEvent.click(screen.getByRole("tab", { name: "Mission chat" }));
    await waitFor(() =>
      expect(document.getElementById("workspace-panel-job-a")).toBeNull()
    );
  });
});
