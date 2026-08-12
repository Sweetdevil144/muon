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
import { SessionWorkspace } from "../src/renderer/session-workspace.js";

/**
 * 0038 — the demo centrepiece, end to end: open a dispatched worker and watch
 * its REAL console.
 *
 * What these tests pin is not "a terminal appears". It is that the tab can
 * never say something untrue: live only when MUON actually owns the vendor
 * child's console, recorded (and labelled) otherwise, a visible notice wherever
 * output went missing, no input channel, and — the original defect — never a
 * spawn.
 */

// The live pane wires a REAL XTerm in production; in jsdom we capture what it
// would have written so the assertions can read the actual console bytes.
const xtermWrites: string[] = [];
const xtermOptions: Array<
  | {
      readOnly?: boolean;
      convertEol?: boolean;
      fixedGrid?: { cols: number; rows: number };
    }
  | undefined
> = [];
vi.mock("../src/renderer/lib/xterm-view.js", () => ({
  createXtermView: (
    _container: HTMLElement,
    options?: {
      readOnly?: boolean;
      convertEol?: boolean;
      fixedGrid?: { cols: number; rows: number };
    }
  ) => {
    xtermOptions.push(options);
    return {
      write: (data: string) => xtermWrites.push(data),
      onInput: () => ({ dispose: vi.fn() }),
      onResize: () => ({ dispose: vi.fn() }),
      markExited: vi.fn(),
      dispose: vi.fn(),
    };
  },
}));

afterEach(() => {
  cleanup();
  xtermWrites.length = 0;
  xtermOptions.length = 0;
});

const AGENT = {
  id: "agent-1",
  vendor: "codex",
  name: "codex-1",
  ordinal: 1,
  status: "working",
  currentTaskId: "task-1",
  currentJobId: "job-1",
} as const;

const JOB = {
  id: "job-1",
  chatId: "chat-1",
  kind: "implement",
  vendor: "codex",
  taskId: "task-1",
  brief: "Fix the parser",
  status: "running",
  dispatchedBy: "orchestrator",
  interruptRequested: false,
  steerMessages: [],
  capabilityMode: "delegate",
  workspacePath: "/repo",
  createdAt: "2026-07-26T10:00:00.000Z",
} as const;

/** The runner's real coordinate shape: `pty:job:<jobId>:<epoch>`. */
const ATTACH = "pty:job:job-1:a1b2c3d4";

function terminalView(over: Record<string, unknown> = {}) {
  return {
    status: "ok",
    sessionId: ATTACH,
    available: true,
    jobStatus: "running",
    frames: [{ seq: 1, data: "$ npm test\r\nPASS  parser\r\n" }],
    firstSeq: 1,
    lastSeq: 1,
    dropped: 0,
    ...over,
  };
}

function stubMuon(overrides: Record<string, unknown> = {}) {
  const open = vi.fn().mockResolvedValue({
    post: vi.fn(),
    onFrame: vi.fn(),
    close: vi.fn(),
  });
  Object.assign(window, {
    muon: {
      streams: vi.fn().mockResolvedValue([]),
      reviewDiff: vi
        .fn()
        .mockResolvedValue({ status: "degraded", reason: "not under test" }),
      workspaceReview: vi
        .fn()
        .mockResolvedValue({ status: "degraded", reason: "n/a", action: "n/a" }),
      terminal: { open, close: vi.fn() },
      jobTerminal: vi.fn().mockResolvedValue(terminalView()),
      ...overrides,
    },
  });
  return { open };
}

function renderTab(job: unknown) {
  render(
    React.createElement(SessionWorkspace, {
      agent: AGENT,
      job,
      taskTitle: "Parser fix",
      events: [],
      readiness: [],
      terminalPreview: true,
      onClose: vi.fn(),
    } as unknown as Parameters<typeof SessionWorkspace>[0])
  );
  fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
}

describe("agent tab live console (0038)", () => {
  it("attaches to the job's REAL console when the runner published one, and shows its bytes", async () => {
    const { open } = stubMuon();
    renderTab({ ...JOB, ptySessionId: ATTACH });

    // The mode is stated before a byte is read.
    expect(
      screen.getByText("Live — this job's console output, read-only")
    ).toBeTruthy();

    await waitFor(() =>
      expect(window.muon.jobTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: "job-1", chatId: "chat-1", afterSeq: 0 })
      )
    );
    await waitFor(() =>
      expect(xtermWrites.join("")).toContain("PASS  parser")
    );

    // THE load-bearing assertion: watching a worker starts nothing. The attach
    // coordinate never reaches the spawn path.
    expect(open).not.toHaveBeenCalled();
    // …and the pane that renders it is read-only at the terminal level too.
    // `convertEol` is the staircase fix: pipe-fed frames carry `\n`-only line
    // endings, and it is idempotent for real pty (`\r\n`) frames.
    //
    // U3 — `fixedGrid` is the codex-specific half: this lane dispatches onto a
    // REAL pty spawned at LANE_PTY_COLS x LANE_PTY_ROWS, its bytes already
    // carry that terminal's wraps and absolute cursor positions, and MUON
    // cannot resize a governed child's pty. Fitting this pane to its own width
    // replayed those bytes against a different geometry, which is what read as
    // a distorted stream.
    expect(xtermOptions[0]).toEqual({
      readOnly: true,
      convertEol: true,
      fixedGrid: { cols: 120, rows: 32 },
    });
  });

  it("mounts the attach pane under the live session id, never the spawn id", async () => {
    stubMuon();
    renderTab({ ...JOB, ptySessionId: ATTACH });
    const pane = await screen.findByRole("log");
    expect(pane.getAttribute("data-session")).toBe(ATTACH);
    expect(pane.getAttribute("data-session")).not.toContain("terminal-");
  });

  /**
   * claude-code runs through the in-process Agent SDK, so MUON never owns that
   * child's stdio and `ptySessionId` is null on every path. That must read as
   * the run's honestly-labelled activity feed, never a blank pane claiming a
   * console.
   */
  it("degrades a claude-code worker to the activity feed and never claims a console", async () => {
    stubMuon({
      streams: vi.fn().mockResolvedValue([
        { seq: 1, kind: "output", content: "reading src/parser.ts" },
      ]),
    });
    renderTab({
      ...JOB,
      vendor: "claude-code",
      ptySessionId: null,
    });

    expect(await screen.findByText(/reading src\/parser\.ts/)).toBeTruthy();
    expect(
      screen.getByText(/Live activity — this agent is working/)
    ).toBeTruthy();
    // The feed may say "live activity" — it IS refreshed as the agent works —
    // but nothing may claim an attached CONSOLE, which is the pane MUON does
    // not have for an SDK lane. The console badge is the only string that
    // says "console"; the feed's note says the opposite in words.
    expect(screen.queryByText(/console output, read-only/)).toBeNull();
    expect(
      screen.getByText(/not an interactive terminal/)
    ).toBeTruthy();
    // No live read is even attempted for a job with no console.
    expect(window.muon.jobTerminal).not.toHaveBeenCalled();
  });

  it("refuses another job's console coordinate and stays on the activity feed", async () => {
    stubMuon({
      streams: vi
        .fn()
        .mockResolvedValue([{ seq: 1, kind: "output", content: "output" }]),
    });
    renderTab({ ...JOB, ptySessionId: "pty:job:job-OTHER:a1b2c3d4" });

    expect(
      await screen.findByText(/Live activity — this agent is working/)
    ).toBeTruthy();
    expect(window.muon.jobTerminal).not.toHaveBeenCalled();
  });

  it("renders a visible gap notice when output was dropped, instead of a seamless lie", async () => {
    stubMuon({
      jobTerminal: vi.fn().mockResolvedValue(
        terminalView({
          frames: [{ seq: 12, data: "…and then it continued\r\n" }],
          firstSeq: 12,
          lastSeq: 12,
          dropped: 7,
        })
      ),
    });
    renderTab({ ...JOB, ptySessionId: ATTACH });

    const notice = await screen.findByText(/Output gap:/);
    expect(notice.textContent).toMatch(/7 frame\(s\) were dropped/);
    expect(notice.textContent).toMatch(/agent itself was never paused/);
    // And the hole is marked in the console itself, at the point it happened.
    await waitFor(() =>
      expect(xtermWrites.join("")).toMatch(/output gap, 18 frame\(s\) missing/)
    );
  });

  it("falls back to the activity feed WITH the reason when there is no live console after all", async () => {
    stubMuon({
      jobTerminal: vi
        .fn()
        .mockResolvedValue(terminalView({ available: false, jobStatus: "done" })),
      streams: vi
        .fn()
        .mockResolvedValue([{ seq: 1, kind: "output", content: "recorded line" }]),
    });
    renderTab({ ...JOB, status: "done", ptySessionId: ATTACH });

    expect(
      await screen.findByText(/Showing the run's activity, not its live console/)
    ).toBeTruthy();
    expect(
      screen.getByText(/no longer holding its live console/)
    ).toBeTruthy();
    expect(await screen.findByText(/recorded line/)).toBeTruthy();
    // The badge stops claiming live at the same instant the pane changes.
    expect(
      screen.queryByText("Live — this job's console output, read-only")
    ).toBeNull();
  });

  it("surfaces a live-read failure on the pane instead of a silent black rectangle", async () => {
    stubMuon({
      jobTerminal: vi.fn().mockRejectedValue(new Error("brain unreachable")),
    });
    renderTab({ ...JOB, ptySessionId: ATTACH });

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/brain unreachable/)).toBeTruthy();
    expect(screen.getByText(/MUON keeps retrying/)).toBeTruthy();
  });

  it("explains an attached-but-silent agent rather than showing an empty pane", async () => {
    stubMuon({
      jobTerminal: vi
        .fn()
        .mockResolvedValue(terminalView({ frames: [], firstSeq: null, lastSeq: 0 })),
    });
    renderTab({ ...JOB, ptySessionId: ATTACH });

    expect(
      await screen.findByText(/has not printed anything yet/)
    ).toBeTruthy();
  });

  it("falls back honestly when the app bridge has no live-terminal read at all", async () => {
    stubMuon({ jobTerminal: undefined });
    renderTab({ ...JOB, ptySessionId: ATTACH });

    expect(
      await screen.findByText(/live console is unavailable in this session/i)
    ).toBeTruthy();
  });

  it("shows a finished job's real console without still calling it live", async () => {
    stubMuon({
      jobTerminal: vi.fn().mockResolvedValue(
        terminalView({
          jobStatus: "done",
          frames: [{ seq: 1, data: "PASS  parser\r\n" }],
          firstSeq: 1,
          lastSeq: 1,
        })
      ),
    });
    renderTab({ ...JOB, status: "done", ptySessionId: ATTACH });

    expect(
      await screen.findByText("Live console — this job has finished")
    ).toBeTruthy();
    expect(
      screen.queryByText("Live — this job's console output, read-only")
    ).toBeNull();
    await waitFor(() =>
      expect(screen.getByText(/end of its console/)).toBeTruthy()
    );
    expect(xtermWrites.join("")).toContain("PASS  parser");
  });

  it("keeps input disabled — and says why — while attached to a live agent", async () => {
    stubMuon();
    renderTab({ ...JOB, ptySessionId: ATTACH });

    await screen.findByRole("log");
    const input = screen.getByLabelText(
      "Send input to this agent"
    ) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByText(/would bypass the approval gate/)).toBeTruthy();
    expect(screen.getByText(/Input is disabled/)).toBeTruthy();
  });
});
